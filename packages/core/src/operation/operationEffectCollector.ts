import type { AtomicBatchItem, PersistenceProvider } from "../persistence/provider"
import type { OutboxRecord } from "../events/durability/outbox"
import type { PostCommitContext } from "./operationContext"
import { ConfigurationError, EffectCollectorDisposedError, EffectCollectorDrainedError } from "../domain"

/** A durable commit obligation that must participate in the business commit boundary. */
export interface CommitMarkerEntry {
  name: string
  /** Pre-batch ownership fence, run by non-transactional (atomic-batch) pipelines before commit. */
  fence?: (persistence: PersistenceProvider) => Promise<void>
  /** In-transaction commit hook, run by transactional pipelines immediately before commit. */
  commit?: (result: unknown, persistence: PersistenceProvider) => Promise<void>
  /** Self-contained atomic-batch item persisted atomically with business commands. */
  batchItem?: (result: unknown) => AtomicBatchItem<unknown> | undefined | Promise<AtomicBatchItem<unknown> | undefined>
}

export interface BestEffortEffectEntry {
  name: string
  execute: (operation?: PostCommitContext) => Promise<void>
}

export interface OperationEffectState {
  outboxRecords: OutboxRecord[]
  bestEffortEffects: BestEffortEffectEntry[]
}

export interface OperationEffectStateWithCommitMarkers extends OperationEffectState {
  commitMarkers: CommitMarkerEntry[]
}

export type EffectCollectorState = "pre-commit" | "post-commit" | "deferred-taken" | "disposed"

export class OperationEffectCollector {
  static readonly defaultMaxDeferredEffects = 1000
  private readonly effectsState: OperationEffectStateWithCommitMarkers
  private deferredEffectCount: number
  private lifecycle: EffectCollectorState = "pre-commit"

  constructor(initial?: Partial<OperationEffectStateWithCommitMarkers>) {
    this.effectsState = {
      outboxRecords: [...(initial?.outboxRecords ?? [])],
      bestEffortEffects: [...(initial?.bestEffortEffects ?? [])],
      commitMarkers: [...(initial?.commitMarkers ?? [])],
    }
    this.deferredEffectCount = this.effectsState.bestEffortEffects.length
    if (this.deferredEffectCount > OperationEffectCollector.defaultMaxDeferredEffects) {
      throw new ConfigurationError("Initial deferred effects exceed the configured budget.")
    }
  }

  get isDisposed(): boolean {
    return this.lifecycle === "disposed"
  }

  get lifecycleState(): EffectCollectorState {
    return this.lifecycle
  }

  get outboxRecords(): OutboxRecord[] {
    return [...this.effectsState.outboxRecords]
  }

  get bestEffortEffects(): BestEffortEffectEntry[] {
    return [...this.effectsState.bestEffortEffects]
  }

  get commitMarkers(): CommitMarkerEntry[] {
    return [...this.effectsState.commitMarkers]
  }

  registerCommitMarker(entry: CommitMarkerEntry): void {
    this.assertPreCommit()
    this.register(() => this.effectsState.commitMarkers.push(entry))
  }

  addOutboxRecord(record: OutboxRecord): void {
    this.assertPreCommit()
    this.register(() => this.effectsState.outboxRecords.push(record))
  }

  addBestEffortEffect(name: string, execute: (operation?: PostCommitContext) => Promise<void>): void {
    this.registerDeferred(() => this.effectsState.bestEffortEffects.push({ name, execute }))
  }

  takePreCommitEffects(): OperationEffectState {
    if (this.lifecycle !== "pre-commit") {
      throw new EffectCollectorDisposedError("Pre-commit effects have already been taken.")
    }
    const drained: OperationEffectState = {
      outboxRecords: this.effectsState.outboxRecords.splice(0),
      bestEffortEffects: this.effectsState.bestEffortEffects.splice(0),
    }
    this.lifecycle = "post-commit"
    return drained
  }

  takeDeferredEffects(): OperationEffectState {
    if (this.lifecycle === "deferred-taken") {
      throw new EffectCollectorDrainedError("Deferred effects have already been taken; register another effect before draining again.")
    }
    if (this.lifecycle !== "post-commit") {
      throw new EffectCollectorDisposedError("Deferred effects can only be taken after the operation has committed.")
    }
    const drained = {
      outboxRecords: [],
      bestEffortEffects: this.effectsState.bestEffortEffects.splice(0),
    }
    this.lifecycle = "deferred-taken"
    return drained
  }

  dispose(): void {
    if (this.lifecycle === "disposed") return
    this.effectsState.outboxRecords.length = 0
    this.effectsState.bestEffortEffects.length = 0
    this.lifecycle = "disposed"
  }

  private register(add: () => void): void {
    if (this.lifecycle === "disposed") {
      throw new EffectCollectorDisposedError("Operation run has been disposed; late effect registration is not allowed.")
    }
    add()
  }

  private registerDeferred(add: () => void): void {
    if (this.lifecycle === "disposed") {
      throw new EffectCollectorDisposedError("Operation run has been disposed; late effect registration is not allowed.")
    }
    if (this.deferredEffectCount >= OperationEffectCollector.defaultMaxDeferredEffects) {
      throw new ConfigurationError("Deferred effect budget exceeded.")
    }
    if (this.lifecycle === "deferred-taken") this.lifecycle = "post-commit"
    this.deferredEffectCount += 1
    add()
  }

  private assertPreCommit(): void {
    if (this.lifecycle !== "pre-commit") {
      throw new EffectCollectorDisposedError("Durable effects can only be registered before commit.")
    }
  }
}
