import type { PreparationOperationContext, RepresentationContext, PostCommitContext } from "./operationContext"

type MaybePromise<T> = T | Promise<T>

export interface BeforeHookContext<TInput, TOperation = PreparationOperationContext> {
  operation: TOperation
  input: TInput
}

export interface AfterHookContext<TInput, TResult> {
  operation: RepresentationContext
  input: TInput
  result: TResult
}

export type { PostCommitContext } from "./operationContext"

export type BeforeHook<TInput, TOperation = PreparationOperationContext> = (context: BeforeHookContext<TInput, TOperation>) => MaybePromise<TInput | void>
export type AfterHook<TInput, TResult> = (context: AfterHookContext<TInput, TResult>) => MaybePromise<TResult | void>
export interface PostCommitHookContext<TInput, TResult> {
  operation: PostCommitContext
  input: TInput
  result: TResult
}

/**
 * afterCommit hooks run after the business commit and are BEST-EFFORT: a
 * failure does not roll back the committed mutation, and a retry does not
 * generically replay arbitrary after-commit work. Correctness-critical work
 * (for example cache invalidation) must be expressed as a durable obligation
 * with its own idempotency (outbox record or the idempotency commit receipt)
 * that is committed atomically with the mutation, never as a plain post-commit
 * callback.
 */
export type AfterCommitHook<TInput, TResult> = (context: PostCommitHookContext<TInput, TResult>) => MaybePromise<void>
export type AtomicAfterCommitHook<TInput, TResult> = AfterCommitHook<TInput, TResult>

export interface OperationHooks<TInput, TResult, TBeforeOperation = PreparationOperationContext> {
  before?: BeforeHook<TInput, TBeforeOperation> | BeforeHook<TInput, TBeforeOperation>[]
  after?: AfterHook<TInput, TResult> | AfterHook<TInput, TResult>[]
  afterCommit?: AfterCommitHook<TInput, TResult> | AfterCommitHook<TInput, TResult>[]
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

export async function runBeforeHooks<TInput, TOperation = PreparationOperationContext>(args: {
  operation: TOperation
  input: TInput
  hooks?: BeforeHook<TInput, TOperation> | BeforeHook<TInput, TOperation>[]
}): Promise<TInput> {
  let currentInput = args.input

  for (const hook of asArray(args.hooks)) {
    const next = await hook({ operation: args.operation, input: currentInput })
    if (next !== undefined) currentInput = next
  }

  return currentInput
}

export async function runAfterHooks<TInput, TResult>(args: {
  operation: RepresentationContext
  input: TInput
  result: TResult
  hooks?: AfterHook<TInput, TResult> | AfterHook<TInput, TResult>[]
}): Promise<TResult> {
  let currentResult = args.result

  for (const hook of asArray(args.hooks)) {
    const next = await hook({ operation: args.operation, input: args.input, result: currentResult })
    if (next !== undefined) currentResult = next
  }

  return currentResult
}

export async function runAfterCommitHooks<TInput, TResult>(args: {
  operation: PostCommitContext
  input: TInput
  result: TResult
  hooks?: AfterCommitHook<TInput, TResult> | AfterCommitHook<TInput, TResult>[]
}): Promise<void> {
  for (const hook of asArray(args.hooks)) {
    await hook({ operation: args.operation, input: args.input, result: args.result })
  }
}
