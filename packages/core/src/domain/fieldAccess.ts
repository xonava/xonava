import { evaluatePredicate } from "./evaluatePredicate"
import { ForbiddenError } from "./errors"
import type { NormalizedAbacPolicy } from "./abacTypes"
import type { FieldDescriptor, FieldFormat } from "../persistence/provider"

type FieldMetadataEntity = {
  fields: Record<string, FieldDescriptor>
}

export type FieldReadMode = "allow" | "omit" | "mask"
export type FieldReadOverride = FieldReadMode

/**
 * Reserved override key carrying the mode for declared fields the plan does not
 * name. Set to "omit" when an allow policy's read map acts as an allowlist, so a
 * field absent from the trusted record cannot default to "allow" at projection.
 */
export const FIELD_READ_DEFAULT_KEY = "*"

/** Restrictiveness ordering used to resolve equal-priority conflicts deterministically. */
const RESTRICTIVENESS: Record<FieldReadMode, number> = { allow: 0, mask: 1, omit: 2 }

/**
 * Resolve conditional field-read overrides against a TRUSTED record. The
 * record passed here must be the durable authorized row, never hook-controlled
 * or enriched data, so a representation hook cannot rewrite the attributes that
 * decided visibility. Equal-priority conflicts resolve to the more restrictive
 * mode so the outcome is independent of policy ordering.
 */
export function resolveFieldReadOverrides(args: {
  policies: NormalizedAbacPolicy[]
  moduleKey: string
  record: Record<string, unknown>
}): Record<string, FieldReadOverride> {
  const matches = args.policies
    .filter((policy) => policy.moduleKey === args.moduleKey && policy.payload.actions.includes("read"))
    .filter((policy) => policy.payload.fieldAccess?.read)
    .filter((policy) => evaluatePredicate(args.record, policy.compiledConditions))
    .sort((left, right) => right.priority - left.priority)

  const overrides: Record<string, FieldReadOverride> = {}
  const priorities = new Map<string, number>()
  let allowlistPriority: number | undefined
  let allowlist: Record<string, FieldReadMode> | undefined

  for (const policy of matches) {
    const read = policy.payload.fieldAccess?.read
    if (policy.effect === "allow" && read && (allowlistPriority === undefined || policy.priority > allowlistPriority)) {
      allowlistPriority = policy.priority
      allowlist = read
      overrides[FIELD_READ_DEFAULT_KEY] = "omit"
      for (const field of Object.keys(args.record)) {
        if (!Object.hasOwn(read, field)) {
          overrides[field] = "omit"
          priorities.set(field, policy.priority)
        }
      }
    }
    for (const [field, mode] of Object.entries(policy.payload.fieldAccess?.read ?? {})) {
      // A field outside the allowlist is implicitly omitted at the allowlist's
      // priority even when it is not a key of the trusted record.
      const implicitlyOmitted = !priorities.has(field) && allowlist !== undefined && allowlistPriority !== undefined && !Object.hasOwn(allowlist, field)
      const previousPriority = implicitlyOmitted ? allowlistPriority : priorities.get(field)
      if (previousPriority !== undefined && previousPriority > policy.priority) continue
      const incoming: FieldReadMode = policy.effect === "deny" ? "omit" : mode
      if (previousPriority === policy.priority) {
        const existing = implicitlyOmitted ? "omit" : overrides[field]
        if (existing !== undefined && RESTRICTIVENESS[existing] >= RESTRICTIVENESS[incoming]) continue
        overrides[field] = incoming
        continue
      }
      overrides[field] = incoming
      priorities.set(field, policy.priority)
    }
  }

  return overrides
}

function maskValue(value: unknown, format: FieldFormat | undefined): unknown {
  if (value === null || value === undefined) return value
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional fallback to string coercion
  const text = typeof value === "string" ? value : String(value)

  if (format === "email") {
    const separator = text.indexOf("@")
    if (separator <= 1) return "[REDACTED]"
    return `${text[0]}***${text.slice(separator)}`
  }

  if (format === "phone" || format === "identifier") {
    return text.length <= 4 ? "[REDACTED]" : `***${text.slice(-4)}`
  }

  if (format === "date") {
    const match = text.match(/^(\d{4})/)
    return match?.[1] ?? "[REDACTED]"
  }

  return "[REDACTED]"
}

export function projectResponseRecord<TRow extends Record<string, unknown>>(args: {
  entity: FieldMetadataEntity
  record: TRow
  overrides?: Record<string, FieldReadOverride>
}): TRow {
  // Only declared entity fields are eligible for response output.
  const redacted: Record<string, unknown> = {}

  for (const [field, descriptor] of Object.entries(args.entity.fields)) {
    if (!(field in args.record)) continue
    const overrides = args.overrides
    const mode = overrides === undefined ? "allow"
      : Object.hasOwn(overrides, field) ? overrides[field]!
        : Object.hasOwn(overrides, FIELD_READ_DEFAULT_KEY) ? overrides[FIELD_READ_DEFAULT_KEY]!
          : "allow"

    if (mode === "omit") {
      delete redacted[field]
      continue
    }

    if (mode === "mask") {
      redacted[field] = maskValue(args.record[field], descriptor.format)
      continue
    }

    redacted[field] = args.record[field]
  }

  return redacted as TRow
}

/** A resolved, immutable field-visibility decision. */
export type FieldVisibilityPlan = Record<string, FieldReadOverride>

function isAlwaysTruePredicate(node: unknown): boolean {
  return typeof node === "object" && node !== null &&
    (node as { kind?: unknown }).kind === "and" &&
    Array.isArray((node as { filters?: unknown }).filters) &&
    (node as { filters: unknown[] }).filters.length === 0
}

/**
 * True when any active update policy grants field writes conditionally on the
 * record. Such decisions are only safe under optimistic concurrency because
 * the authorization-driving row state can otherwise change between the field
 * decision and the mutation.
 */
export function hasRecordDependentFieldWrite(
  policies: NormalizedAbacPolicy[],
  moduleKey: string,
  action: string,
): boolean {
  return policies.some((policy) =>
    policy.moduleKey === moduleKey &&
    policy.payload.actions.includes(action) &&
    Array.isArray(policy.payload.fieldAccess?.write) &&
    policy.payload.fieldAccess.write.length > 0 &&
    !isAlwaysTruePredicate(policy.compiledConditions)
  )
}

export function assertPolicyWritableFields(args: {
  policies: NormalizedAbacPolicy[]
  moduleKey: string
  action: string
  record: Record<string, unknown>
  changedFields?: string[]
}): void {
  const relevant = args.policies
    .filter((p) => p.moduleKey === args.moduleKey && p.payload.actions.includes(args.action))
    .filter((p) => evaluatePredicate(args.record, p.compiledConditions))

  if (relevant.length === 0) return

  // Only the highest matching priority tier is evaluated
  const priorities = Array.from(new Set(relevant.map((p) => p.priority))).sort((a, b) => b - a)
  const topPriority = priorities[0]
  const topTier = relevant.filter((p) => p.priority === topPriority)

  const denyPolicies = topTier.filter((p) => p.effect === "deny")
  const allowPolicies = topTier.filter((p) => p.effect === "allow")

  const denyAll = denyPolicies.some((p) => !p.payload.fieldAccess?.write?.length)
  const allowAll = allowPolicies.some((p) => !p.payload.fieldAccess?.write?.length)

  const fields = args.changedFields ?? Object.keys(args.record)
  const denied: string[] = []

  for (const field of fields) {
    // Deny + missing write list → all fields denied
    if (denyAll) {
      denied.push(field)
      continue
    }
    // Deny + write list → listed fields denied
    const fieldDenied = denyPolicies.some((p) => (p.payload.fieldAccess?.write ?? []).includes(field))
    if (fieldDenied) {
      denied.push(field)
      continue
    }

    // Allow + missing write list → all fields allowed
    if (allowAll) continue
    // Allow + write list → only listed fields allowed
    const fieldAllowed = allowPolicies.some((p) => (p.payload.fieldAccess?.write ?? []).includes(field))
    if (fieldAllowed) continue

    // Not mentioned by any allow policy with lists → implicitly denied
    if (allowPolicies.length > 0) {
      denied.push(field)
    }
  }

  if (denied.length > 0) {
    throw new ForbiddenError("You do not have permission to update one or more fields.", {
      fields: denied,
      reasonCode: "ABAC_FIELD_WRITE_DENIED",
    })
  }
}

export interface FieldQueryAccess {
  filter: string[]
  search: string[]
  sort: string[]
}

const FIELD_QUERY_MODES = ["filter", "search", "sort"] as const

function emptyFieldQueryAccess(): FieldQueryAccess {
  return { filter: [], search: [], sort: [] }
}

/**
 * Fields hidden by any module policy's read map. Conditions cannot be evaluated
 * here (there is no record yet), so the decision is conservative: any read
 * restriction declared on a field denies query access to it until an explicit
 * query grant re-allows the specific mode.
 */
function collectDeniedQueryFields(policies: NormalizedAbacPolicy[], moduleKey: string, onlyDenyEffect = false): string[] {
  const denied: string[] = []
  for (const policy of policies) {
    if (policy.moduleKey !== moduleKey) continue
    if (onlyDenyEffect && policy.effect === "allow") continue
    const read = policy.payload.fieldAccess?.read
    if (!read) continue
    for (const [field, mode] of Object.entries(read)) {
      // Deny-effect policies fold every read mode to omit, mirroring
      // resolveFieldReadOverrides. Allow-effect policies hide omit/mask fields.
      if (policy.effect !== "allow" || mode === "omit" || mode === "mask") {
        if (!denied.includes(field)) denied.push(field)
      }
    }
  }
  return denied
}

/**
 * Only allow-effect policies grant query access, and a grant can only re-open
 * a field an allow policy masks/omits: a deny's omission is never subtracted.
 */
function collectQueryGrants(policies: NormalizedAbacPolicy[], moduleKey: string): FieldQueryAccess {
  const grants = emptyFieldQueryAccess()
  const hardDenied = collectDeniedQueryFields(policies, moduleKey, true)
  for (const policy of policies) {
    if (policy.moduleKey !== moduleKey || policy.effect !== "allow") continue
    const query = policy.payload.fieldAccess?.query
    if (!query) continue
    for (const mode of FIELD_QUERY_MODES) {
      for (const field of query[mode] ?? []) {
        if (!hardDenied.includes(field) && !grants[mode].includes(field)) grants[mode].push(field)
      }
    }
  }
  return grants
}

/**
 * Resolve the fields a caller may use for filter/search/sort under ABAC.
 *
 * Rule: a field is query-allowable only when it is NOT masked/conditionally
 * hidden. A field declared `omit` or `mask` in `fieldAccess.read` is
 * query-DENIED unless explicitly granted in `fieldAccess.query`. A field with
 * no read restriction (or an explicit `allow` read mode) is query-allowed,
 * matching the current behavior for unrestricted fields. Fields not referenced
 * by any policy are unrestricted and remain query-allowed.
 */
export function resolveFieldQueryAccess(args: {
  policies: NormalizedAbacPolicy[]
  moduleKey: string
}): FieldQueryAccess {
  const deniedFields = collectDeniedQueryFields(args.policies, args.moduleKey)
  const allowed = emptyFieldQueryAccess()
  const grants = collectQueryGrants(args.policies, args.moduleKey)
  for (const mode of FIELD_QUERY_MODES) {
    for (const field of grants[mode]) {
      if (!allowed[mode].includes(field)) allowed[mode].push(field)
    }
  }
  // Explicitly readable fields carry no read restriction, so they stay
  // query-allowed across every mode unless another policy hides them.
  for (const policy of args.policies) {
    if (policy.moduleKey !== args.moduleKey) continue
    const read = policy.payload.fieldAccess?.read
    if (!read) continue
    for (const [field, mode] of Object.entries(read)) {
      if (mode === "allow" && policy.effect === "allow" && !deniedFields.includes(field)) {
        for (const queryMode of FIELD_QUERY_MODES) {
          if (!allowed[queryMode].includes(field)) allowed[queryMode].push(field)
        }
      }
    }
  }
  return allowed
}

/**
 * Effective DENY lists per query mode. Callers that own the candidate field
 * universe (entity-declared filterable/searchable/sortable columns) subtract
 * these from it; a masked field is denied unless an explicit query grant
 * re-allows the specific mode.
 */
export function resolveFieldQueryDenials(args: {
  policies: NormalizedAbacPolicy[]
  moduleKey: string
}): FieldQueryAccess {
  const deniedFields = collectDeniedQueryFields(args.policies, args.moduleKey)
  const grants = collectQueryGrants(args.policies, args.moduleKey)
  return {
    filter: deniedFields.filter((field) => !grants.filter.includes(field)),
    search: deniedFields.filter((field) => !grants.search.includes(field)),
    sort: deniedFields.filter((field) => !grants.sort.includes(field)),
  }
}

export function assertFieldQueryAccess(args: {
  denied: string[]
  fields: string[]
  mode: "filter" | "search" | "sort"
}): void {
  const offending = args.fields.filter((field) => args.denied.includes(field))
  if (offending.length === 0) return
  throw new ForbiddenError(
    `Querying field(s) ${offending.join(", ")} via ${args.mode} is not permitted by policy`,
    { fields: offending, reasonCode: "ABAC_FIELD_QUERY_DENIED" },
  )
}
