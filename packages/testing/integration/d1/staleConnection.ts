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

/**
 * Wraps a Miniflare D1 binding (and the prepared statements it returns) so that a call which failed only because
 * the keep-alive connection was stale is repeated once on a fresh connection. Any other error, and a second
 * stale-connection failure, propagate unchanged.
 */
export function tolerateStaleConnections<T extends object>(binding: T): T {
  // batch() takes the prepared statements this wrapper handed out; the binding must receive the statements themselves.
  const unwrap = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(unwrap)
    return typeof value === "object" && value !== null ? wrappedTargets.get(value) ?? value : value
  }
  const proxy = new Proxy(binding, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        const invoke = (): unknown => (value as (...parameters: unknown[]) => unknown).apply(target, args.map(unwrap))
        let result: unknown
        try {
          result = invoke()
        } catch (error) {
          if (!isStaleConnectionError(error)) throw error
          result = invoke()
        }
        if (isPromiseLike(result)) {
          return Promise.resolve(result).catch((error: unknown) => {
            if (!isStaleConnectionError(error)) throw error
            return invoke()
          })
        }
        return typeof result === "object" && result !== null ? tolerateStaleConnections(result) : result
      }
    },
  })
  wrappedTargets.set(proxy, binding)
  return proxy
}
