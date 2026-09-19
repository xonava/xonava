import { ConfigurationError, ConflictError } from "../domain"
import { supportsInteractiveTransactions } from "../persistence"
import type { AggregateDefinition, AggregateInvariantPhase, AggregateSnapshot, AggregateTransactionOptions, AggregateTransactionResult, CompiledAggregateDefinition } from "./types"

const compiledAggregates = new WeakSet<object>()
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

function immutable(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) throw new ConfigurationError("Aggregate snapshot must not contain cycles")
  seen.add(value)
  if (Array.isArray(value)) return Object.freeze(value.map(item => immutable(item, seen)))
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) throw new ConfigurationError("Aggregate snapshot values must be plain records and arrays")
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, item] of Object.entries(value)) copy[key] = immutable(item, seen)
  return Object.freeze(copy)
}

export class AggregateInvariantError extends ConflictError {
  readonly aggregateKey: string
  readonly invariantKey: string
  readonly phase: Exclude<AggregateInvariantPhase, "both">
  constructor(aggregateKey: string, invariantKey: string, phase: Exclude<AggregateInvariantPhase, "both">) {
    super("Aggregate invariant failed", { aggregateKey, invariantKey, phase })
    this.aggregateKey = aggregateKey
    this.invariantKey = invariantKey
    this.phase = phase
  }
}

function snapshot<TSnapshot extends AggregateSnapshot>(value: TSnapshot, members: readonly string[]): TSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigurationError("Aggregate snapshot must be a record")
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const member of members) {
    if (!Object.hasOwn(value, member)) throw new ConfigurationError(`Aggregate snapshot is missing member "${member}"`)
    copy[member] = immutable(value[member])
  }
  for (const key of Object.keys(value)) if (!members.includes(key)) throw new ConfigurationError(`Aggregate snapshot contains undeclared member "${key}"`)
  return Object.freeze(copy) as TSnapshot
}

export function compileAggregate<TSnapshot extends AggregateSnapshot>(definition: AggregateDefinition<TSnapshot>): CompiledAggregateDefinition<TSnapshot> {
  if (!definition || typeof definition !== "object" || !KEY.test(definition.key)) throw new ConfigurationError("Aggregate key is invalid")
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new ConfigurationError("Aggregate version must be a positive safe integer")
  if (!Array.isArray(definition.members) || definition.members.length < 1 || definition.members.length > 100) throw new ConfigurationError("Aggregate must declare between 1 and 100 members")
  const members = [...definition.members]
  if (members.some(member => !KEY.test(member)) || new Set(members).size !== members.length) throw new ConfigurationError("Aggregate members must be unique valid keys")
  if (!Array.isArray(definition.invariants) || definition.invariants.length < 1 || definition.invariants.length > 100) throw new ConfigurationError("Aggregate must declare between 1 and 100 invariants")
  const invariantKeys = new Set<string>()
  const invariants = definition.invariants.map(invariant => {
    if (!invariant || !KEY.test(invariant.key) || invariantKeys.has(invariant.key)) throw new ConfigurationError("Aggregate invariant keys must be unique valid keys")
    if (!["before", "after", "both"].includes(invariant.phase) || typeof invariant.check !== "function") throw new ConfigurationError(`Aggregate invariant "${invariant.key}" is invalid`)
    invariantKeys.add(invariant.key)
    return Object.freeze({ key: invariant.key, phase: invariant.phase, check: invariant.check })
  })
  const compiled = Object.freeze({ key: definition.key, version: definition.version, members: Object.freeze(members), invariants: Object.freeze(invariants) }) as CompiledAggregateDefinition<TSnapshot>
  compiledAggregates.add(compiled)
  return compiled
}

export function isCompiledAggregate(value: unknown): value is CompiledAggregateDefinition {
  return typeof value === "object" && value !== null && compiledAggregates.has(value)
}

export function assertAggregateInvariants<TSnapshot extends AggregateSnapshot>(definition: CompiledAggregateDefinition<TSnapshot>, value: TSnapshot, phase: Exclude<AggregateInvariantPhase, "both">): TSnapshot {
  if (!isCompiledAggregate(definition)) throw new ConfigurationError("Aggregate invariant evaluation requires a compiled aggregate")
  const state = snapshot(value, definition.members)
  for (const invariant of definition.invariants) {
    if (invariant.phase !== "both" && invariant.phase !== phase) continue
    let valid: boolean
    try { valid = invariant.check(state) }
    catch (error) { throw new ConfigurationError(`Aggregate invariant "${invariant.key}" threw during evaluation`, error) }
    if (valid !== true) throw new AggregateInvariantError(definition.key, invariant.key, phase)
  }
  return state
}

/** Validate a proposed atomic-batch transition before commands are committed. */
export function assertAggregateTransition<TSnapshot extends AggregateSnapshot>(definition: CompiledAggregateDefinition<TSnapshot>, before: TSnapshot, proposed: TSnapshot): { readonly before: TSnapshot; readonly after: TSnapshot } {
  return Object.freeze({ before: assertAggregateInvariants(definition, before, "before"), after: assertAggregateInvariants(definition, proposed, "after") })
}

/** Run reads, mutation, and post-state invariant checks inside one existing provider transaction. */
export async function runAggregateTransaction<TSnapshot extends AggregateSnapshot, TResult>(options: AggregateTransactionOptions<TSnapshot, TResult>): Promise<AggregateTransactionResult<TResult, TSnapshot>> {
  if (!isCompiledAggregate(options.definition)) throw new ConfigurationError("Aggregate transaction requires a compiled aggregate")
  if (!supportsInteractiveTransactions(options.persistence)) throw new ConfigurationError(`Aggregate "${options.definition.key}" requires interactive transaction support`)
  if (typeof options.load !== "function" || typeof options.mutate !== "function") throw new ConfigurationError("Aggregate transaction requires load and mutate functions")
  return options.persistence.runInTransaction(async persistence => {
    const before = assertAggregateInvariants(options.definition, await options.load(persistence), "before")
    const result = await options.mutate(persistence, before)
    const after = assertAggregateInvariants(options.definition, await options.load(persistence), "after")
    return Object.freeze({ result, before, after })
  }, { isolationLevel: "serializable", accessMode: "read write", ...options.transaction })
}
