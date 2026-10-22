import { describe, expect, it, vi } from "vitest"
import { forAllAsync, type Rng } from "./harness"
import { ABAC_PROPERTY_TIMEOUT_MS,
  ABAC_MODULE, FIELD_KEYS, POLICY_CASE_OPTIONS, READ_MODES, WILDCARD_FIELD, bindPolicies, generatePolicies, generateRows, shrinkPolicyCase,
  type PolicyOptions,
} from "./abacArbitraries"
import {
  actionPolicies, effectiveReadMode, generateWriteCases, queryDenials, readPlan, referenceFieldWritable, referenceWriteDecision, referencedFields,
  writeOutcome, type WriteCase,
} from "./abacOracle"
import { DIFFERENTIAL_FIELDS } from "./arbitraries"
import { createAbacAuthorizer } from "../../domain/abacAuthorizer"
import { evaluateAbacRecordAction } from "../../domain/abacDecision"
import { buildActionScope } from "../../domain/abacReadScope"
import { evaluateWriteAccessForRecordDetailed } from "../../domain/abacWrite"
import { evaluatePredicate } from "../../domain/evaluatePredicate"
import { assertPolicyWritableFields, hasRecordDependentFieldWrite, projectResponseRecord, resolveFieldQueryAccess } from "../../domain/fieldAccess"
import type { FieldDescriptor, FieldFormat } from "../../persistence/provider"
import type { NormalizedAbacPolicy } from "../../domain/abacTypes"

/**
 * Field-level ABAC: read plans vs query denials vs projection, and the write
 * path (record decision under both images, field-write tier, create rules).
 */

vi.setConfig({ testTimeout: ABAC_PROPERTY_TIMEOUT_MS })

interface FieldCase {
  policies: NormalizedAbacPolicy[]
  rows: Array<Record<string, unknown>>
  formats: Record<string, FieldFormat | undefined>
}

const FORMATS: ReadonlyArray<FieldFormat | undefined> = [undefined, undefined, "text", "email", "phone", "identifier", "date", "json"]

function generateFieldCase(options: PolicyOptions & { min?: number; max?: number }) {
  return (rng: Rng): FieldCase => {
    const formats: Record<string, FieldFormat | undefined> = {}
    for (const field of FIELD_KEYS) formats[field] = rng.pick(FORMATS)
    return { policies: generatePolicies(rng, options), rows: generateRows(rng, 10), formats }
  }
}

const READ_SCENARIOS: Array<{ name: string; options: PolicyOptions & { min?: number; max?: number } }> = [
  { name: "read maps everywhere", options: { fieldAccessRate: 0.9 } },
  { name: "conditional read maps with ties", options: { fieldAccessRate: 0.9, unconditionalRate: 0.2, min: 2, max: 7 } },
  { name: "read maps with the reserved * key", options: { fieldAccessRate: 1, wildcardRate: 0.5 } },
]

function entityOf(formats: Record<string, FieldFormat | undefined>): { fields: Record<string, FieldDescriptor> } {
  const fields: Record<string, FieldDescriptor> = {}
  for (const { key } of DIFFERENTIAL_FIELDS) {
    const format = formats[key]
    fields[key] = { type: "string", ...(format ? { format } : {}) }
  }
  return { fields }
}

/** True only for the unconditional predicate (`and` with no filters), the one condition that holds for every row. */
function isUnconditional(policy: NormalizedAbacPolicy): boolean {
  const condition = policy.compiledConditions
  return condition.kind === "and" && condition.filters.length === 0
}

/** Fields an allow policy's query grant re-opens for `mode`: never one a deny's read map hides, and only from an unconditional policy. */
function grantedQueryFields(policies: readonly NormalizedAbacPolicy[], mode: "filter" | "search" | "sort"): Set<string> {
  // A deny read map naming "*" omits every field by default, so it hard-denies them all.
  const hardDenied = new Set(policies.filter((policy) => policy.moduleKey === ABAC_MODULE && policy.effect === "deny").flatMap((policy) => {
    const read = policy.payload.fieldAccess?.read ?? {}
    return Object.hasOwn(read, WILDCARD_FIELD) ? [...FIELD_KEYS] : Object.keys(read)
  }))
  const granted = new Set<string>()
  for (const policy of policies) {
    if (policy.moduleKey !== ABAC_MODULE || policy.effect !== "allow" || !isUnconditional(policy)) continue
    for (const field of policy.payload.fieldAccess?.query?.[mode] ?? []) if (!hardDenied.has(field)) granted.add(field)
  }
  return granted
}

describe("ABAC differential: read plan ⇒ query denials ⇒ projection", () => {
  for (const scenario of READ_SCENARIOS) {
    it(`a field hidden for any row is query-denied unless explicitly granted, and projection honours the plan (${scenario.name})`, async () => {
      await forAllAsync(`abac read plan vs query ${scenario.name}`, generateFieldCase(scenario.options), async ({ policies, rows, formats }) => {
        const bundle = await bindPolicies(policies)
        const denials = queryDenials(bundle)
        const access = resolveFieldQueryAccess({ policies: bundle.policies, moduleKey: bundle.moduleKey, fields: FIELD_KEYS })
        const entity = entityOf(formats)
        const authorizer = createAbacAuthorizer(bundle)
        for (const mode of ["filter", "search", "sort"] as const) {
          const granted = grantedQueryFields(bundle.policies, mode)
          // Allowed and denied never overlap.
          for (const field of access[mode]) expect(denials[mode], `${mode}: ${field} both allowed and denied`).not.toContain(field)
          for (const row of rows) {
            const plan = readPlan(bundle, row)
            expect(authorizer.fieldReadPlan(row)).toEqual(plan)
            for (const field of FIELD_KEYS) {
              const readMode = effectiveReadMode(plan, field)
              if (readMode === "allow" || granted.has(field)) continue
              expect(denials[mode], `${field} is ${readMode} for ${JSON.stringify(row)} but ${mode} is not denied`).toContain(field)
            }
          }
        }
        for (const row of rows) {
          const plan = readPlan(bundle, row)
          const projected = projectResponseRecord({ entity, record: row, overrides: plan })
          for (const field of Object.keys(projected)) expect(FIELD_KEYS).toContain(field)
          for (const field of FIELD_KEYS) {
            const readMode = effectiveReadMode(plan, field)
            const raw = row[field]
            if (!Object.hasOwn(row, field) || readMode === "omit") {
              expect(Object.hasOwn(projected, field), `${field} (${readMode}) emitted for ${JSON.stringify(row)}`).toBe(false)
            } else if (readMode === "mask") {
              if (raw !== null && raw !== undefined) expect(projected[field], `masked ${field} leaked its raw value`).not.toEqual(raw)
            } else {
              expect(projected[field]).toEqual(raw)
            }
          }
        }
      }, { runs: 300, ...POLICY_CASE_OPTIONS, shrink: shrinkPolicyCase<FieldCase> })
    })
  }

  it("a query grant never lifts a denial the record decision would keep for some row", async () => {
    // Grants are static (a query is not evaluated per row), so only an
    // unconditional allow may lift a denial. A conditional allow's grant, or a
    // grant naming a field a row's plan hides, must leave the field denied.
    await forAllAsync("abac query grant vs record decision", generateFieldCase({ fieldAccessRate: 0.9, unconditionalRate: 0.3, min: 2, max: 7 }), async ({ policies, rows }) => {
      const bundle = await bindPolicies(policies)
      const denials = queryDenials(bundle)
      const unconditionallyGranted = (mode: "filter" | "search" | "sort") => {
        const fields = new Set<string>()
        for (const policy of bundle.policies) {
          if (policy.effect !== "allow" || !isUnconditional(policy)) continue
          for (const field of policy.payload.fieldAccess?.query?.[mode] ?? []) fields.add(field)
        }
        return fields
      }
      for (const mode of ["filter", "search", "sort"] as const) {
        const grantedByUnconditional = unconditionallyGranted(mode)
        for (const field of FIELD_KEYS) {
          const hiddenForSomeRow = rows.some((row) => effectiveReadMode(readPlan(bundle, row), field) !== "allow")
          if (!hiddenForSomeRow || denials[mode].includes(field)) continue
          expect(grantedByUnconditional.has(field), `${mode}: ${field} hidden for a row yet not denied without an unconditional grant`).toBe(true)
        }
      }
    }, { runs: 300, ...POLICY_CASE_OPTIONS, shrink: shrinkPolicyCase<FieldCase> })
  })

  it("a deny's read map hides its fields on every row it may match and is never re-opened by a grant", async () => {
    await forAllAsync("abac deny read map", generateFieldCase({ fieldAccessRate: 1, wildcardRate: 0 }), async ({ policies, rows }) => {
      const bundle = await bindPolicies(policies)
      const denials = queryDenials(bundle)
      for (const policy of bundle.policies) {
        if (policy.effect !== "deny") continue
        for (const field of Object.keys(policy.payload.fieldAccess?.read ?? {})) {
          for (const mode of ["filter", "search", "sort"] as const) expect(denials[mode]).toContain(field)
          if (!policy.payload.actions.includes("read")) continue
          // Read maps are tiered: a strictly higher-priority read map naming the field decides it.
          const outranked = bundle.policies.some((other) => other.priority > policy.priority && other.payload.actions.includes("read") && Object.hasOwn(other.payload.fieldAccess?.read ?? {}, field))
          if (outranked) continue
          for (const row of rows) {
            if (evaluatePredicate(row, { kind: "not", filter: policy.compiledConditions })) continue
            expect(effectiveReadMode(readPlan(bundle, row), field), `${policy.source.policyId} hides ${field}`).toBe("omit")
          }
        }
      }
    }, { runs: 200, ...POLICY_CASE_OPTIONS, shrink: shrinkPolicyCase<FieldCase> })
  })
})

interface WriteCaseBundle {
  policies: NormalizedAbacPolicy[]
  rows: Array<Record<string, unknown>>
  writes: WriteCase[]
}

function generateWriteBundle(options: PolicyOptions & { min?: number; max?: number }) {
  return (rng: Rng): WriteCaseBundle => {
    const policies = generatePolicies(rng, options)
    const rows = generateRows(rng, 8)
    return { policies, rows, writes: generateWriteCases(rng, rows, 14) }
  }
}

function* shrinkWriteBundle(value: WriteCaseBundle): Generator<WriteCaseBundle> {
  if (value.writes.length > 1) for (const write of value.writes) yield { ...value, writes: [write] }
  for (const policies of shrinkPolicyCase({ ...value, rows: [{}] })) yield { ...value, policies: policies.policies }
}

const WRITE_SCENARIOS: Array<{ name: string; options: PolicyOptions & { min?: number; max?: number } }> = [
  { name: "mixed", options: { fieldAccessRate: 0.6 } },
  { name: "write lists with ties", options: { fieldAccessRate: 0.9, unconditionalRate: 0.3, min: 2, max: 7 } },
  { name: "UNKNOWN-heavy", options: { fields: DIFFERENTIAL_FIELDS.filter((field) => field.key === "ownerId" || field.key === "active" || field.key === "amount"), fieldAccessRate: 0.6 } },
]

describe("ABAC differential: writes", () => {
  for (const scenario of WRITE_SCENARIOS) {
    it(`enforceAbacWrite throws iff either image is denied or a changed field is not writable at the deciding tier (${scenario.name})`, async () => {
      await forAllAsync(`abac write oracle ${scenario.name}`, generateWriteBundle(scenario.options), async ({ policies, writes }) => {
        const bundle = await bindPolicies(policies)
        const authorizer = createAbacAuthorizer(bundle)
        for (const write of writes) {
          const images = write.existing !== undefined ? [write.existing, write.record] : [write.record]
          const fields = write.changedFields ?? Object.keys(write.record)
          const expectedOk = images.every((image) =>
            referenceWriteDecision(bundle, write.action, image).allowed &&
            (write.action === "delete" || fields.every((field) => referenceFieldWritable(bundle, write.action, image, field))))
          const outcome = writeOutcome(bundle, write)
          expect(outcome === "ok", `${JSON.stringify(write)} → ${outcome}`).toBe(expectedOk)
          let viaAuthorizer = true
          try {
            authorizer.assertWrite(write)
          } catch {
            viaAuthorizer = false
          }
          expect(viaAuthorizer).toBe(outcome === "ok")
          if (write.action !== "create") {
            // Update/delete record decisions are the action decision, i.e. the scope.
            const scope = buildActionScope({ bundle, action: write.action }).filter
            for (const image of images) {
              expect(evaluateWriteAccessForRecordDetailed({ policies: bundle.policies, moduleKey: bundle.moduleKey, action: write.action, record: image }).allowed)
                .toBe(evaluateAbacRecordAction({ bundle, action: write.action, record: image }).allowed)
            }
            if (outcome === "ok") for (const image of images) expect(evaluatePredicate(image, scope), `allowed ${write.action} outside its scope`).toBe(true)
          }
        }
      }, { runs: 250, shrink: shrinkWriteBundle, maxShrinkSteps: 400, describe: POLICY_CASE_OPTIONS.describe })
    })
  }

  it("create: an explicit null on a referenced field never turns a deny into an allow", async () => {
    await forAllAsync("abac create explicit null", generateWriteBundle({ fieldAccessRate: 0.5, unconditionalRate: 0.2 }), async ({ policies, writes }) => {
      const bundle = await bindPolicies(policies)
      const referenced = new Set(actionPolicies(bundle, "create").flatMap((policy) => [...referencedFields(policy.compiledConditions)]))
      for (const write of writes) {
        if (write.action !== "create") continue
        for (const field of referenced) {
          if (Object.hasOwn(write.record, field)) continue
          const withNull: WriteCase = { action: "create", record: { ...write.record, [field]: null }, changedFields: [...(write.changedFields ?? []), field] }
          const sameFields: WriteCase = { ...withNull, changedFields: write.changedFields ?? [] }
          const before = writeOutcome(bundle, write)
          for (const variant of [withNull, sameFields]) {
            if (writeOutcome(bundle, variant) === "ok") expect(before, `null ${field} allowed but absent ${field} denied: ${JSON.stringify(variant)}`).toBe("ok")
          }
          const decision = (record: Record<string, unknown>) => evaluateWriteAccessForRecordDetailed({ policies: bundle.policies, moduleKey: bundle.moduleKey, action: "create", record }).allowed
          if (decision(withNull.record)) expect(decision(write.record)).toBe(true)
        }
      }
    }, { runs: 250, shrink: shrinkWriteBundle, describe: POLICY_CASE_OPTIONS.describe })
  })

  it("create: with every referenced field present, the create decision is the record decision", async () => {
    await forAllAsync("abac create complete record", generateWriteBundle({ unconditionalRate: 0.2 }), async ({ policies, rows }) => {
      const bundle = await bindPolicies(policies)
      const referenced = actionPolicies(bundle, "create").flatMap((policy) => [...referencedFields(policy.compiledConditions)])
      for (const row of rows) {
        const complete = { ...row }
        for (const field of referenced) if (!Object.hasOwn(complete, field)) complete[field] = null
        expect(evaluateWriteAccessForRecordDetailed({ policies: bundle.policies, moduleKey: bundle.moduleKey, action: "create", record: complete }).allowed)
          .toBe(evaluateAbacRecordAction({ bundle, action: "create", record: complete }).allowed)
      }
    }, { runs: 200, ...POLICY_CASE_OPTIONS })
  })

  it("field-write decisions are record-independent whenever hasRecordDependentFieldWrite says so", async () => {
    // The update handler only demands optimistic concurrency when this
    // predicate is true; if it is false the field decision must not depend on
    // which (update-permitted) version of the row it was taken against.
    await forAllAsync("abac record-dependent field write", generateWriteBundle({ fieldAccessRate: 0.7, unconditionalRate: 0.4 }), async ({ policies, rows }) => {
      const bundle = await bindPolicies(policies)
      if (hasRecordDependentFieldWrite(bundle.policies, bundle.moduleKey, "update")) return
      const deniedSets = new Map<string, Record<string, unknown>>()
      for (const row of rows) {
        if (!evaluateAbacRecordAction({ bundle, action: "update", record: row }).allowed) continue
        let denied: string[] = []
        try {
          assertPolicyWritableFields({ policies: bundle.policies, moduleKey: bundle.moduleKey, action: "update", record: row, changedFields: [...FIELD_KEYS] })
        } catch (error) {
          denied = [...((error as { details?: { fields?: string[] } }).details?.fields ?? [])].sort()
        }
        deniedSets.set(denied.join(","), row)
      }
      expect(deniedSets.size, `field-write outcome differs between update-permitted rows: ${JSON.stringify([...deniedSets])}`).toBeLessThanOrEqual(1)
    }, { runs: 300, ...POLICY_CASE_OPTIONS })
  })
})

describe("ABAC differential: read-mode vocabulary", () => {
  it("plans only ever contain declared modes", async () => {
    await forAllAsync("abac read modes", generateFieldCase({ fieldAccessRate: 1, wildcardRate: 0.3 }), async ({ policies, rows }) => {
      const bundle = await bindPolicies(policies)
      for (const row of rows) {
        const plan = readPlan(bundle, row)
        for (const [field, mode] of Object.entries(plan)) {
          expect(READ_MODES).toContain(mode)
          expect([...FIELD_KEYS, WILDCARD_FIELD]).toContain(field)
        }
      }
    }, { runs: 100, ...POLICY_CASE_OPTIONS, shrink: shrinkPolicyCase<FieldCase> })
  })
})

/** Other spellings of the calendar date `day` that a database would cast to that date. */
function dateSpellings(day: string): unknown[] {
  return [
    `${day}T00:00:00Z`, `${day}T00:00:00.000Z`, `${day}T05:30:00+05:30`, `${day}T23:59:59-05:00`, `${day}T00:00`,
    ` ${day}`, `${day} `, day.replace(/-/g, ""), `${day}T00:00:00.000000Z`,
  ]
}

describe("ABAC differential: date spellings on write", () => {
  it("no spelling of a date passes a write the canonical YYYY-MM-DD spelling is denied, and a UTC-midnight Date decides identically", async () => {
    const dateHeavy = { fields: DIFFERENTIAL_FIELDS.filter((field) => field.key === "dueOn" || field.key === "ownerId"), unconditionalRate: 0.2, fieldAccessRate: 0.4, min: 1 }
    await forAllAsync("abac date spellings on write", generateWriteBundle(dateHeavy), async ({ policies, writes }) => {
      const bundle = await bindPolicies(policies)
      for (const write of writes) {
        if (write.action === "delete") continue
        const day = write.record.dueOn
        if (typeof day !== "string") continue
        const changedFields = [...new Set([...(write.changedFields ?? Object.keys(write.record)), "dueOn"])]
        const canonical = writeOutcome(bundle, { ...write, changedFields })
        const respell = (value: unknown): WriteCase => ({ ...write, record: { ...write.record, dueOn: value }, changedFields })
        expect(writeOutcome(bundle, respell(new Date(`${day}T00:00:00.000Z`))), `Date(${day})`).toBe(canonical)
        for (const spelling of dateSpellings(day)) {
          const outcome = writeOutcome(bundle, respell(spelling))
          if (outcome === "ok") expect(canonical, `${JSON.stringify(spelling)} passed where ${day} is ${canonical}`).toBe("ok")
        }
      }
    }, { runs: 300, shrink: shrinkWriteBundle, describe: POLICY_CASE_OPTIONS.describe })
  })
})
