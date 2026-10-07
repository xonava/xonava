import type { AuthorizationOperationContext, PreparationOperationContext, ReadOperationContext, ReadExecutionContext, MutationOperationContext, PostCommitContext, RetryableOperationContext } from "./operationContext"
import type { AfterCommitHook, OperationHooks } from "./hooks"
import type { RuntimeCapability } from "../bootstrap/runtimeCapabilities"
import type { TransactionOptions } from "../persistence/provider"
import type { AuditFieldClassifications } from "../events/durability/audit"
import type { OperationDataAccessDeclaration } from "./operationResources"
import type { AuthorizedExecutionPlan } from "../security"

export type MaybePromise<T> = T | Promise<T>

export type StandardAtomicityMode = "none" | "preferred" | "required"

export type OperationKind = "read" | "mutation"

/**
 * Bounded retries for failures raised before an interactive transaction commits.
 * The operation callback, including its hooks and transactional effects, is
 * rerun from the beginning for each attempt. Best-effort effects are never
 * part of a retry attempt.
 */
export interface TransactionExecution {
  kind: "transaction"
}

export interface RetryableTransactionExecution {
  kind: "retryable-transaction"
  maxAttempts: number
  delay: number
  backoff: number
  maxDelay: number
}

export type OperationExecution = TransactionExecution | RetryableTransactionExecution

export interface StandardAtomicity {
  kind: "standard"
  mode: StandardAtomicityMode
  transactionOptions?: TransactionOptions
}

export interface AtomicBatchAtomicity {
  kind: "atomic-batch"
}

export type OperationAtomicity = StandardAtomicity | AtomicBatchAtomicity

export interface AuthorizationDecision {
  allowed: boolean
  reason?: string
  /** A framework-created plan activates mandatory predicate, field, obligation and fact enforcement. */
  plan?: AuthorizedExecutionPlan
}

export interface OperationAuthorizationPort<TInput = unknown> {
  authorize(args: { operation: AuthorizationOperationContext; input: TInput }): Promise<AuthorizationDecision>
}

/** The delivery guarantee requested for an operation audit record. */
export type AuditGuarantee = "atomic" | "durable" | "best-effort"

export interface OperationAuditConfig<TInput, TResult> {
  action: string
  resourceType: string
  required?: boolean
  auditGuarantee?: AuditGuarantee
  fallbackAuditGuarantee?: "best-effort"
  resolveResourceId: (args: { input: TInput; result: TResult }) => string
  extractOldValue?: (args: { input: TInput }) => Record<string, unknown> | null
  extractNewValue?: (args: { input: TInput; result: TResult }) => Record<string, unknown> | null
  fieldClassification?: AuditFieldClassifications
}

export interface BaseOperationDefinition<TInput, TResult, TBeforeOperation = PreparationOperationContext> extends OperationHooks<TInput, TResult, TBeforeOperation> {
  key: string
  kind: OperationKind
  atomicity?: OperationAtomicity
  execution?: OperationExecution
  authorization?: OperationAuthorizationPort<TInput>
  securitySensitive?: boolean
  requiredRuntimeCapabilities?: readonly RuntimeCapability[]
  audit?: OperationAuditConfig<TInput, TResult>
  outbox?: { required: boolean }
  /** Explicit logical datasource and resource authority requested by this operation. */
  dataAccess?: OperationDataAccessDeclaration
}

export interface StandardReadOperationDefinition<TInput, TResult> extends BaseOperationDefinition<TInput, TResult, PreparationOperationContext> {
  kind: "read"
  atomicity?: StandardAtomicity
  execute: (args: { operation: ReadExecutionContext; input: TInput }) => MaybePromise<TResult>
}

export interface StandardMutationOperationDefinition<TInput, TResult> extends Omit<BaseOperationDefinition<TInput, TResult, PreparationOperationContext>, "execution"> {
  kind: "mutation"
  atomicity: StandardAtomicity & { mode: "required" }
  execution?: TransactionExecution
  authorization: OperationAuthorizationPort<TInput>
  execute: (args: { operation: MutationOperationContext; input: TInput }) => MaybePromise<TResult>
  /** Optional adapter-native fallback when interactive transactions are unavailable. */
  atomicBatch?: {
    prepare: (args: {
      operation: AtomicBatchPreparationContext<unknown>
      input: TInput
    }) => MaybePromise<PreparedAtomicBatch<unknown, TResult>>
  }
}

export interface RetryableMutationOperationDefinition<TInput, TResult> extends Omit<BaseOperationDefinition<TInput, TResult, PreparationOperationContext>, "kind" | "atomicity" | "authorization" | "execution"> {
  kind: "mutation"
  atomicity: StandardAtomicity & { mode: "required" }
  execution: RetryableTransactionExecution
  authorization: OperationAuthorizationPort<TInput>
  execute: (args: { operation: RetryableOperationContext; input: TInput }) => MaybePromise<TResult>
}

export type StandardOperationDefinition<TInput, TResult> =
  | StandardReadOperationDefinition<TInput, TResult>
  | StandardMutationOperationDefinition<TInput, TResult>
  | RetryableMutationOperationDefinition<TInput, TResult>

export interface PreparedAtomicBatch<TCommand, TResult> {
  commands: readonly TCommand[]
  /** The domain result represented by the prepared commands. */
  result: TResult
  /** Verifies raw command results after the provider has committed the batch. */
  verify?: (args: { result: TResult; commandResults: readonly unknown[] }) => MaybePromise<void>
}

export type AtomicBatchPreparation<TCommand, TResult> = PreparedAtomicBatch<TCommand, TResult>

export interface AtomicBatchPreparationContext<TCommand = unknown> {
  readonly operationId: string
  readonly correlationId?: string
  readonly request?: ReadOperationContext["request"]
  readonly services: ReadOperationContext["services"]
  readonly signal: AbortSignal
  readonly deadline: ReadOperationContext["deadline"]
  addCommand(command: TCommand): void
  addOutboxRecord: (record: import("../events/durability/outbox").NewOutboxRecord) => void
  addDurableEffect: MutationOperationContext["addDurableEffect"]
  addBestEffortEffect: (name: string, execute: (operation?: PostCommitContext) => Promise<void>) => void
}

export interface AtomicBatchOperationDefinition<TInput, TResult, TCommand = unknown>
  extends Omit<BaseOperationDefinition<TInput, TResult, PreparationOperationContext>, "afterCommit" | "kind" | "authorization"> {
  kind: "mutation"
  authorization: OperationAuthorizationPort<TInput>
  atomicity: AtomicBatchAtomicity
  afterCommit?: AfterCommitHook<TInput, TResult> | AfterCommitHook<TInput, TResult>[]
  prepare: (args: { operation: AtomicBatchPreparationContext<TCommand>; input: TInput }) => MaybePromise<PreparedAtomicBatch<TCommand, TResult>>
}

export type OperationDefinition<TInput, TResult, TCommand = unknown> =
  | StandardOperationDefinition<TInput, TResult>
  | AtomicBatchOperationDefinition<TInput, TResult, TCommand>
