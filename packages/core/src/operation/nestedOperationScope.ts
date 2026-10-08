import { CancelledError, ConfigurationError, OperationContextInactiveError } from "../domain/errors"
import { isTenantScopedPersistenceProvider, type PersistenceProvider } from "../persistence/provider"
import { registerTenantScopedProvider } from "../persistence/tenantScopeBrand"
import type { NestedOperationInvoke } from "./operationContext"
import type { InternalOperationRunContext } from "./operationRunContext"

/** Longest delay a platform timer honours; longer delays would fire immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * The part of one parent run that nested operations may use. It closes when
 * the parent's `execute` finishes (or fails); after that no child may start,
 * and a joined child's handle on the parent's transaction fails closed.
 */
export interface NestedOperationScope {
  /** Aborts when the parent run's signal aborts or the parent fails while children run. */
  readonly signal: AbortSignal
  assertOpen(): void
  /** Wraps the parent's transaction-scoped persistence so it fails closed once the scope ends. */
  guardPersistence<T extends PersistenceProvider>(persistence: T): T
}

export type NestedInvokeFactory = (parent: InternalOperationRunContext, options: { readonly joinTransaction: boolean; readonly readOnly: boolean; readonly scope: NestedOperationScope }) => NestedOperationInvoke

export interface NestedInvocationTracker {
  readonly invoke: NestedOperationInvoke | undefined
  /** Refuses to let the parent complete over a failed or still running child. */
  assertSettled(key: string): void
  /**
   * The parent failed: closes the scope, cancels running children and waits
   * for them, bounded by the run deadline, so the parent's transaction cannot
   * end underneath them. Never throws.
   */
  abandon(): Promise<void>
  /** The parent's `execute` finished: children may no longer start or use its transaction. */
  close(): void
}

/**
 * Wraps the nested invoker of one parent run. A joined child's writes share
 * the parent's transaction, so the parent must neither commit nor roll back
 * while one is still running.
 */
export function trackNestedInvocations(
  parent: InternalOperationRunContext,
  factory: NestedInvokeFactory | undefined,
  options: { readonly joinTransaction: boolean; readonly readOnly: boolean },
): NestedInvocationTracker {
  if (!factory) return { invoke: undefined, assertSettled: () => undefined, abandon: () => Promise.resolve(), close: () => undefined }
  let open = true
  let failed = false
  let controller: AbortController | undefined
  const pending = new Set<Promise<unknown>>()
  // Created on first use so runs without children add no listener; the link
  // to the parent signal is released when the parent run is disposed.
  const linkedController = (): AbortController => {
    if (controller) return controller
    const created = new AbortController()
    controller = created
    const source = parent.signal
    if (source.aborted) {
      created.abort(source.reason)
    } else {
      const onAbort = (): void => created.abort(source.reason)
      source.addEventListener("abort", onAbort, { once: true })
      parent.effects.onDispose(() => source.removeEventListener("abort", onAbort))
    }
    return created
  }
  const scope: NestedOperationScope = {
    get signal() { return linkedController().signal },
    assertOpen: () => {
      if (!open) throw new OperationContextInactiveError("The parent operation has finished; its nested operation scope is closed.")
    },
    guardPersistence: (persistence) => guardPersistence(persistence, scope.assertOpen),
  }
  const invoke = factory(parent, { ...options, scope })
  return {
    invoke: async (definition, input) => {
      scope.assertOpen()
      const running = invoke(definition, input)
      pending.add(running)
      try {
        return await running
      } catch (error) {
        failed = true
        throw error
      } finally {
        pending.delete(running)
      }
    },
    assertSettled: (key) => {
      if (pending.size > 0) throw new ConfigurationError(`Operation ${key} returned before its nested operations completed.`)
      if (failed) throw new ConfigurationError(`Operation ${key} cannot complete after a nested operation failed.`)
    },
    abandon: async () => {
      open = false
      if (pending.size === 0) return
      controller?.abort(new CancelledError("The parent operation failed; nested operations are cancelled."))
      let remaining = 0
      try {
        remaining = parent.deadline.expiresAt.getTime() - parent.services.clock.now().getTime()
      } catch {
        remaining = 0
      }
      if (!(remaining > 0)) return
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.min(remaining, MAX_TIMER_DELAY_MS)) }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
    close: () => { open = false },
  }
}

/**
 * Every property read and method call on the provider, and on objects its
 * methods return synchronously (repositories), first asserts the scope is
 * open. Methods run against the real provider, so private state still works.
 * The proxy target is a plain shell so frozen providers can still be wrapped.
 */
function guardPersistence<T extends PersistenceProvider>(persistence: T, assertOpen: () => void): T {
  const guarded = guardObject(persistence, assertOpen, true)
  if (isTenantScopedPersistenceProvider(persistence)) registerTenantScopedProvider(guarded)
  return guarded
}

function guardObject<T extends object>(target: T, assertOpen: () => void, guardResults: boolean): T {
  return new Proxy({} as T, {
    get(_shell, property) {
      assertOpen()
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      return (...args: unknown[]): unknown => {
        assertOpen()
        const result: unknown = Reflect.apply(value, target, args)
        if (!guardResults || typeof result !== "object" || result === null || typeof (result as { then?: unknown }).then === "function") return result
        return guardObject(result, assertOpen, false)
      }
    },
    has: (_shell, property) => Reflect.has(target, property),
    ownKeys: () => Reflect.ownKeys(target),
    getOwnPropertyDescriptor: (_shell, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
      return descriptor ? { ...descriptor, configurable: true } : undefined
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
    set: (_shell, property, value) => { assertOpen(); return Reflect.set(target, property, value, target) },
    defineProperty: () => false,
    deleteProperty: () => false,
  })
}
