import { ConfigurationError, ValidationError, compareCodePoints, evaluatePredicate, type PredicateNode } from "../domain"
import { parseIsoInstant } from "../kernel/isoInstant"
import { snapshotRuleData } from "./snapshot"
import type { CompiledRuleSet, RuleAction, RuleDefinition, RuleEvaluationResult, RuleEvaluationTraceEntry, RuleMatch, RuleSetDefinition } from "./types"

const compiledRuleSets = new WeakSet<object>()
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
/** Maximum rules (all versions) in one rule set. */
export const MAX_RULE_SET_RULES = 10_000
/** Maximum distinct data nodes (objects and arrays) in one rule definition, including its predicate and actions. */
export const MAX_RULE_NODES = 10_000
/** Default conflict groups live in a namespace a validated conflict key can never enter. */
const IMPLICIT_CONFLICT_GROUP = "\u0000rule:"

/**
 * Snapshot budget for a rule set or its evaluation result, derived from the
 * declared limits: each rule contributes at most MAX_RULE_NODES plus one match
 * and one trace entry, and the containers add a constant overhead.
 */
function ruleSetNodeBudget(ruleCount: number): number {
  return 4 + ruleCount * (MAX_RULE_NODES + 2)
}

const OPS = new Set(["eq", "neq", "contains", "startsWith", "endsWith", "isEmpty", "isNotEmpty", "gt", "lt", "gte", "lte", "isTrue", "isFalse", "isNull", "isNotNull", "in", "includesAny", "includesAll", "between"])

function instant(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = parseIsoInstant(value)
  // Strict parse first (the `Date.parse` round trip alone accepts expanded-year forms such as "+010000-01-01T00:00:00.000Z"), then the canonical-form check.
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new ConfigurationError(`${label} must be a canonical ISO-8601 instant`)
  return parsed
}

function validatePredicate(root: PredicateNode): void {
  let count = 0
  const visit = (node: PredicateNode, depth: number): void => {
    if (++count > 1_000 || depth > 32 || !node || typeof node !== "object") throw new ConfigurationError("Rule predicate exceeds structural limits")
    switch (node.kind) {
      case "literal": if (typeof node.value !== "boolean") throw new ConfigurationError("Rule predicate literal must be boolean"); return
      case "condition":
        if (!node.field?.trim() || node.field.length > 200 || !OPS.has(node.op)) throw new ConfigurationError("Rule predicate condition is invalid")
        snapshotRuleData(node.value, "Rule predicate value")
        return
      case "not": visit(node.filter, depth + 1); return
      case "and": case "or":
        if (!Array.isArray(node.filters)) throw new ConfigurationError("Rule predicate group is invalid")
        for (const child of node.filters) visit(child, depth + 1)
        return
      default: throw new ConfigurationError("Rule predicate kind is invalid")
    }
  }
  visit(root, 0)
}

function validateRule<TAction extends RuleAction>(rule: RuleDefinition<TAction>): void {
  if (typeof rule.key !== "string" || !KEY.test(rule.key)) throw new ConfigurationError("Rule key is invalid")
  if (!Number.isSafeInteger(rule.version) || rule.version < 1) throw new ConfigurationError(`Rule "${rule.key}" version must be a positive safe integer`)
  if (!Number.isSafeInteger(rule.priority)) throw new ConfigurationError(`Rule "${rule.key}" priority must be a safe integer`)
  if (!Array.isArray(rule.actions) || rule.actions.length === 0 || rule.actions.length > 100) throw new ConfigurationError(`Rule "${rule.key}" must declare between 1 and 100 actions`)
  if (rule.conflictKey !== undefined && (typeof rule.conflictKey !== "string" || !KEY.test(rule.conflictKey))) throw new ConfigurationError(`Rule "${rule.key}" conflict key is invalid`)
  if (rule.description !== undefined && (!rule.description.trim() || rule.description.length > 500)) throw new ConfigurationError(`Rule "${rule.key}" description is invalid`)
  const from = instant(rule.effectiveFrom, `Rule "${rule.key}" effectiveFrom`)
  const until = instant(rule.effectiveUntil, `Rule "${rule.key}" effectiveUntil`)
  if (from !== undefined && until !== undefined && from >= until) throw new ConfigurationError(`Rule "${rule.key}" effective window must be increasing`)
  validatePredicate(rule.when)
  snapshotRuleData(rule, `Rule "${rule.key}"`, { maxNodes: MAX_RULE_NODES })
}

export function compileRuleSet<TAction extends RuleAction>(definition: RuleSetDefinition<TAction>): CompiledRuleSet<TAction> {
  if (!definition || typeof definition !== "object" || typeof definition.key !== "string" || !KEY.test(definition.key)) throw new ConfigurationError("Rule-set key is invalid")
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new ConfigurationError("Rule-set version must be a positive safe integer")
  if (!Array.isArray(definition.rules) || definition.rules.length > MAX_RULE_SET_RULES) throw new ConfigurationError("Rule-set rules are invalid")
  if (!definition.conflictResolution || !["all-matches", "highest-priority", "highest-priority-per-key"].includes(definition.conflictResolution.kind)) throw new ConfigurationError("Rule-set conflict resolution is invalid")
  if (definition.conflictResolution.kind !== "all-matches" && !["rule-key", "error"].includes(definition.conflictResolution.onPriorityTie)) throw new ConfigurationError("Rule-set priority tie behavior is invalid")
  const identities = new Set<string>()
  for (const rule of definition.rules) {
    validateRule(rule)
    const identity = `${rule.key}\0${rule.version}`
    if (identities.has(identity)) throw new ConfigurationError(`Duplicate rule version: ${rule.key}@${rule.version}`)
    identities.add(identity)
  }
  const compiled = snapshotRuleData(definition, "Rule set", { maxNodes: ruleSetNodeBudget(definition.rules.length) })
  compiledRuleSets.add(compiled)
  return compiled
}

export function isCompiledRuleSet(value: unknown): value is CompiledRuleSet {
  return typeof value === "object" && value !== null && compiledRuleSets.has(value)
}

function active(rule: RuleDefinition, now: number): boolean {
  return (rule.effectiveFrom === undefined || Date.parse(rule.effectiveFrom) <= now) && (rule.effectiveUntil === undefined || now < Date.parse(rule.effectiveUntil))
}

function compareRules(a: RuleDefinition, b: RuleDefinition): number {
  return b.priority - a.priority || compareCodePoints(a.key, b.key) || b.version - a.version
}

function selectWinner<TAction extends RuleAction>(rules: readonly RuleDefinition<TAction>[], tie: "rule-key" | "error", scope: string): RuleDefinition<TAction> {
  const ordered = [...rules].sort(compareRules)
  if (tie === "error" && ordered.length > 1 && ordered[0]!.priority === ordered[1]!.priority) throw new ConfigurationError(`Rule priority tie in ${scope}: ${ordered[0]!.priority}`)
  return ordered[0]!
}

export function evaluateRuleSet<TAction extends RuleAction>(compiled: CompiledRuleSet<TAction>, facts: Readonly<Record<string, unknown>>, evaluatedAt: Date): RuleEvaluationResult<TAction> {
  if (!isCompiledRuleSet(compiled)) throw new ConfigurationError("evaluateRuleSet requires a compiled rule set")
  if (!(evaluatedAt instanceof Date) || Number.isNaN(evaluatedAt.getTime())) throw new ConfigurationError("Rule evaluation requires a valid trusted timestamp")
  const data = snapshotRuleData(facts, "Rule facts", { errorType: ValidationError })
  const now = evaluatedAt.getTime()
  const trace = new Map<RuleDefinition<TAction>, RuleEvaluationTraceEntry>()
  const activeRules = compiled.rules.filter(rule => {
    if (!active(rule, now)) { trace.set(rule, { key: rule.key, version: rule.version, priority: rule.priority, disposition: "inactive", ...(rule.conflictKey ? { conflictKey: rule.conflictKey } : {}) }); return false }
    return true
  })
  const current = new Map<string, RuleDefinition<TAction>>()
  for (const rule of activeRules) {
    const previous = current.get(rule.key)
    if (!previous || rule.version > previous.version) {
      if (previous) trace.set(previous, { key: previous.key, version: previous.version, priority: previous.priority, disposition: "superseded", ...(previous.conflictKey ? { conflictKey: previous.conflictKey } : {}) })
      current.set(rule.key, rule)
    } else trace.set(rule, { key: rule.key, version: rule.version, priority: rule.priority, disposition: "superseded", ...(rule.conflictKey ? { conflictKey: rule.conflictKey } : {}) })
  }
  const matching: RuleDefinition<TAction>[] = []
  for (const rule of current.values()) {
    if (evaluatePredicate(data, rule.when)) matching.push(rule)
    else trace.set(rule, { key: rule.key, version: rule.version, priority: rule.priority, disposition: "not-matched", ...(rule.conflictKey ? { conflictKey: rule.conflictKey } : {}) })
  }
  let selected: RuleDefinition<TAction>[]
  const resolution = compiled.conflictResolution
  if (resolution.kind === "all-matches") selected = [...matching].sort(compareRules)
  else if (resolution.kind === "highest-priority") selected = matching.length ? [selectWinner(matching, resolution.onPriorityTie, `rule set "${compiled.key}"`)] : []
  else {
    const groups = new Map<string, RuleDefinition<TAction>[]>()
    for (const rule of matching) {
      const key = rule.conflictKey ?? `${IMPLICIT_CONFLICT_GROUP}${rule.key}`
      const group = groups.get(key) ?? []
      group.push(rule); groups.set(key, group)
    }
    selected = [...groups.entries()].map(([key, rules]) => selectWinner(rules, resolution.onPriorityTie, key.startsWith(IMPLICIT_CONFLICT_GROUP) ? `rule "${rules[0]!.key}"` : `conflict key "${key}"`)).sort(compareRules)
  }
  const selectedSet = new Set(selected)
  for (const rule of matching) trace.set(rule, { key: rule.key, version: rule.version, priority: rule.priority, disposition: selectedSet.has(rule) ? "selected" : "conflict-discarded", ...(rule.conflictKey ? { conflictKey: rule.conflictKey } : {}) })
  const matches: RuleMatch<TAction>[] = selected.map(rule => ({ key: rule.key, version: rule.version, priority: rule.priority, ...(rule.conflictKey ? { conflictKey: rule.conflictKey } : {}), actions: rule.actions }))
  return snapshotRuleData({ ruleSetKey: compiled.key, ruleSetVersion: compiled.version, evaluatedAt: new Date(evaluatedAt), matches, actions: matches.flatMap(match => match.actions), trace: compiled.rules.map(rule => trace.get(rule)!) }, "Rule evaluation result", { maxNodes: ruleSetNodeBudget(compiled.rules.length) })
}
