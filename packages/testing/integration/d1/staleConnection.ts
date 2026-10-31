/**
 * Miniflare reaches the local D1 over an HTTP keep-alive connection (undici). workerd closes a connection that
 * has been idle for about five seconds, while undici only notices on its own 4 s timer, and that timer cannot
 * fire while this process is not running JavaScript (CPU-bound test code, a long GC pause, a starved CPU). The
 * first request after such a gap is written to a socket the server already closed and fails with
 * `fetch failed` <- `SocketError: other side closed (UND_ERR_SOCKET)` although the database is healthy. That is
 * a property of the local test transport only: the request was never read by the server, so sending it again
 * on a fresh connection is exactly what a browser or any HTTP client does for a stale keep-alive socket.
 */
const STALE_SOCKET_CODES = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"])
const MAX_CAUSE_DEPTH = 8

export function isStaleConnectionError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (typeof code === "string" && STALE_SOCKET_CODES.has(code)) return true
    if (typeof message === "string" && /other side closed/i.test(message)) return true
    current = cause
  }
  return false
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function"
}

const wrappedTargets = new WeakMap<object, object>()
/** What a wrapped object may be repeated safely: a statement's SQL is read-only (or unknown, as in unit-test doubles). */
const retrySafety = new WeakMap<object, boolean>()

/**
 * A request that failed with a stale-socket error may or may not have been executed: the server can run a statement
 * and close the socket before the response is read, and under CPU starvation that is exactly what is observed. Only
 * a statement that is harmless to run twice may therefore be repeated. A repeated write is not harmless: it ran
 * once, the repetition reports "0 rows changed", and the caller concludes the write did not happen.
 */
function isReadOnlySql(sql: unknown): boolean {
  return typeof sql !== "string" || /^\s*(select|pragma|explain)\b/i.test(sql)
}

/** Idle time after which this process may have been unable to notice that the server closed its idle sockets. */
const QUIET_BEFORE_REVALIDATING_MS = 1_000

/** The methods that send a request to the database. */
const REQUEST_METHODS = new Set(["run", "all", "first", "raw", "exec", "batch"])

/**
 * Wraps a Miniflare D1 binding (and the prepared statements it returns) so that a read that failed only because
 * the keep-alive connection was stale is repeated once on a fresh connection. A write is never repeated, since it
 * may already have been executed (see `isReadOnlySql`). Instead, stale connections are kept from being used:
 *
 * - requests are sent one at a time, so the HTTP client keeps a single connection that is in constant use rather than
 *   several that sit idle between bursts of concurrent calls until the server closes them (D1 itself serializes
 *   statements, so no ordering the database could produce is lost);
 * - the first request after a quiet spell is preceded by a read-only round trip and a turn of the event loop, which
 *   lets undici discard a socket the server closed while this process could not run JavaScript.
 *
 * Any other error, and a second stale-connection failure of a read, propagate unchanged.
 */
export function tolerateStaleConnections<T extends object>(binding: T): T {
  let lastActivity = Date.now()
  let queue: Promise<unknown> = Promise.resolve()
  // The revalidating read goes to the binding directly: it runs inside a queued request and must not wait for itself.
  const revalidateAfterQuietSpell = async (): Promise<void> => {
    if (Date.now() - lastActivity <= QUIET_BEFORE_REVALIDATING_MS) return
    const probe = (): Promise<unknown> => (binding as unknown as { prepare(sql: string): { all(): Promise<unknown> } }).prepare("SELECT 1").all()
    await probe().catch((error: unknown) => { if (!isStaleConnectionError(error)) throw error; return probe() })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const wrap = <U extends object>(target: U): U => {
    // batch() takes the prepared statements this wrapper handed out; the binding must receive the statements themselves.
    const unwrap = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(unwrap)
      return typeof value === "object" && value !== null ? wrappedTargets.get(value) ?? value : value
    }
    const safeToRepeat = (method: string, args: unknown[], self: object): boolean => {
      if (method === "exec") return isReadOnlySql(args[0])
      if (method === "batch") return Array.isArray(args[0]) && args[0].every((statement) => typeof statement !== "object" || statement === null || retrySafety.get(statement) !== false)
      if (method === "run" || method === "all" || method === "first" || method === "raw") return retrySafety.get(self) !== false
      return true
    }
    const proxy: U = new Proxy(target, {
      get(inner, property) {
        const value: unknown = Reflect.get(inner, property, inner)
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          const name = String(property)
          const repeatable = safeToRepeat(name, args, proxy)
          const invoke = (): unknown => (value as (...parameters: unknown[]) => unknown).apply(inner, args.map(unwrap))
          const finish = (result: unknown): unknown => {
            if (typeof result !== "object" || result === null) return result
            const wrapped = wrap(result)
            // A statement remembers whether its SQL is read-only; bind() hands the same answer to the bound statement.
            if (name === "prepare") retrySafety.set(wrapped, isReadOnlySql(args[0]))
            else if (name === "bind") retrySafety.set(wrapped, retrySafety.get(proxy) !== false)
            return wrapped
          }
          const retryRead = (error: unknown): unknown => {
            if (!repeatable || !isStaleConnectionError(error)) throw error
            return invoke()
          }
          if (REQUEST_METHODS.has(name)) {
            const request = async (): Promise<unknown> => {
              await revalidateAfterQuietSpell()
              try {
                return await invoke()
              } catch (error) {
                return await retryRead(error)
              } finally {
                lastActivity = Date.now()
              }
            }
            const task = queue.then(request, request)
            queue = task.then(() => undefined, () => undefined)
            return task
          }
          let result: unknown
          try {
            result = invoke()
          } catch (error) {
            result = retryRead(error)
          }
          if (isPromiseLike(result)) return Promise.resolve(result).catch(retryRead)
          return finish(result)
        }
      },
    })
    wrappedTargets.set(proxy, target)
    return proxy
  }
  return wrap(binding)
}
