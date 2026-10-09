import { describe, expect, it } from "vitest"
import { bindAbacSecurityDigest } from "../abacBundleIntegrity"
import { createAbacAuthorizer } from "../abacAuthorizer"
import { hasGlobalAbacCapability, resolveGrantedGlobalCapabilities } from "../abacCapabilities"
import { evaluateAbacRecordAction, evaluateAbacRecordCapability, evaluateGlobalAbacCapability } from "../abacDecision"
import { buildActionScope } from "../abacReadScope"
import { enforceAbacWrite, evaluateWriteAccessForRecordDetailed } from "../abacWrite"
import { coercePolicyValue, PolicyValidationError } from "../coercePolicyValue"
import { evaluatePredicate } from "../evaluatePredicate"
import { ForbiddenError } from "../errors"
import { assertPolicyWritableFields, resolveFieldQueryAccess, resolveFieldQueryDenials, resolveFieldReadOverrides } from "../fieldAccess"
import { assertFrameworkAuthorization } from "../frameworkAuthorization"
import { Predicate, type PredicateNode } from "../predicate"
import type { NormalizedAbacPolicy, VerifiedAbacPolicyBundle } from "../abacTypes"
import type { ParsedPolicyPayload } from "../abacPolicySchema"

const MODULE = "tenant.records"

function policy(args: {
  id: string
  effect?: "allow" | "deny"
  priority?: number
  actions?: string[]
  capabilities?: string[]
  when?: PredicateNode
  fieldAccess?: ParsedPolicyPayload["fieldAccess"]
}): NormalizedAbacPolicy {
  return {
    source: { policyId: args.id, scopeType: "tenant_default" },
    moduleKey: MODULE,
    effect: args.effect ?? "allow",
    priority: args.priority ?? 10,
    payload: {
      actions: args.actions ?? ["read", "create", "update", "delete"],
      capabilities: args.capabilities ?? [],
      conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
      ...(args.fieldAccess ? { fieldAccess: args.fieldAccess } : {}),
    },
    compiledConditions: args.when ?? Predicate.alwaysTrue(),
  }
}

const fieldCatalog = {
  id: { key: "id", type: "string" as const, operators: ["equals" as const] },
  name: { key: "name", type: "string" as const, operators: ["equals" as const] },
  salary: { key: "salary", type: "number" as const, operators: ["greaterOrEqual" as const] },
}

async function bundle(policies: NormalizedAbacPolicy[], moduleKey = MODULE): Promise<VerifiedAbacPolicyBundle> {
  return bindAbacSecurityDigest({ mode: "tenant", moduleKey, policies, context: { tenantId: "t1", userId: "u1" }, defaultEffect: "deny", fieldCatalog })
}

describe("read allowlists deny query use of unlisted fields", () => {
  const allowlist = policy({ id: "allowlist", actions: ["read"], fieldAccess: { read: { id: "allow", name: "allow" } } })
  const fields = Object.keys(fieldCatalog)

  it("denies filter/search/sort on a field the read allowlist omits", () => {
    expect(resolveFieldReadOverrides({ policies: [allowlist], moduleKey: MODULE, record: { id: "1", name: "n", salary: 9 } }).salary).toBe("omit")
    const denials = resolveFieldQueryDenials({ policies: [allowlist], moduleKey: MODULE, fields })
    expect(denials.filter).toEqual(["salary"])
    expect(denials.search).toEqual(["salary"])
    expect(denials.sort).toEqual(["salary"])
    expect(resolveFieldQueryAccess({ policies: [allowlist], moduleKey: MODULE, fields }).filter).not.toContain("salary")
  })

  it("is conservative across tiers: a field hidden by any applicable allowlist is denied", () => {
    const wider = policy({ id: "wider", priority: 100, actions: ["read"], when: Predicate.eq("name", "x"), fieldAccess: { read: { id: "allow", name: "allow", salary: "allow" } } })
    expect(resolveFieldQueryDenials({ policies: [wider, allowlist], moduleKey: MODULE, fields }).filter).toEqual(["salary"])
  })

  it("mirrors the read path: only read allow policies form allowlists, and query grants still re-open", () => {
    const updateOnly = policy({ id: "u", actions: ["update"], fieldAccess: { read: { id: "allow" } } })
    expect(resolveFieldQueryDenials({ policies: [updateOnly], moduleKey: MODULE, fields }).filter).toEqual([])
    const granted = policy({ id: "g", actions: ["read"], fieldAccess: { read: { id: "allow", name: "allow" }, query: { sort: ["salary"] } } })
    const denials = resolveFieldQueryDenials({ policies: [granted], moduleKey: MODULE, fields })
    expect(denials.filter).toEqual(["salary"])
    expect(denials.sort).toEqual([])
  })
})

describe("equal-priority read allowlists intersect", () => {
  const a = policy({ id: "a", actions: ["read"], fieldAccess: { read: { id: "allow", name: "allow" } } })
  const b = policy({ id: "b", actions: ["read"], fieldAccess: { read: { id: "mask", salary: "allow" } } })
  const record = { id: "1", name: "n", salary: 9 }

  it("is independent of policy order and shows only fields every allowlist lists", () => {
    const ab = resolveFieldReadOverrides({ policies: [a, b], moduleKey: MODULE, record })
    const ba = resolveFieldReadOverrides({ policies: [b, a], moduleKey: MODULE, record })
    expect(ab).toEqual(ba)
    expect(ab).toEqual({ "*": "omit", id: "mask", name: "omit", salary: "omit" })
  })

  it("keeps query denials consistent with the intersection", () => {
    const denials = resolveFieldQueryDenials({ policies: [a, b], moduleKey: MODULE, fields: Object.keys(fieldCatalog) })
    expect(denials.filter.sort()).toEqual(["id", "name", "salary"])
  })

  it("lets a single higher-priority allowlist override lower ones", () => {
    const top = policy({ id: "top", priority: 100, actions: ["read"], fieldAccess: { read: { name: "allow", salary: "allow" } } })
    const plan = resolveFieldReadOverrides({ policies: [a, b, top], moduleKey: MODULE, record })
    expect(plan).toEqual({ "*": "omit", id: "omit", name: "allow", salary: "allow" })
  })
})

describe("field-write restrictions consider the pre-image", () => {
  const lockedNotesOnly = policy({ id: "locked", priority: 100, actions: ["update"], when: Predicate.isTrue("locked"), fieldAccess: { write: ["notes"] } })
  const everything = policy({ id: "all", priority: 10, actions: ["update"] })
  const existing = { id: "1", locked: true, price: 10, notes: "" }
  const patch = { locked: false, price: 0 }

  it("rejects a patch that escapes the restricting policy by changing its condition", async () => {
    expect(() => assertPolicyWritableFields({
      policies: [lockedNotesOnly, everything], moduleKey: MODULE, action: "update",
      record: { ...existing, ...patch }, existing, changedFields: Object.keys(patch),
    })).toThrow(ForbiddenError)
    const verified = await bundle([lockedNotesOnly, everything])
    expect(() => enforceAbacWrite({ bundle: verified, action: "update", record: { ...existing, ...patch }, existing, changedFields: Object.keys(patch) })).toThrow(ForbiddenError)
    expect(() => createAbacAuthorizer(verified).assertWrite({ action: "update", record: { ...existing, ...patch }, existing, changedFields: Object.keys(patch) })).toThrow(ForbiddenError)
  })

  it("still allows changes both images permit", async () => {
    const verified = await bundle([lockedNotesOnly, everything])
    expect(() => enforceAbacWrite({ bundle: verified, action: "update", record: { ...existing, notes: "n" }, existing, changedFields: ["notes"] })).not.toThrow()
    const unlocked = { ...existing, locked: false }
    expect(() => enforceAbacWrite({ bundle: verified, action: "update", record: { ...unlocked, price: 1 }, existing: unlocked, changedFields: ["price"] })).not.toThrow()
  })

  it("requires the record decision against the pre-image too", async () => {
    const denyArchived = policy({ id: "deny", effect: "deny", priority: 100, actions: ["update"], when: Predicate.eq("status", "archived") })
    const verified = await bundle([denyArchived, policy({ id: "all", actions: ["create", "update"] })])
    expect(() => enforceAbacWrite({ bundle: verified, action: "update", record: { status: "active" }, changedFields: ["status"] })).not.toThrow()
    expect(() => enforceAbacWrite({ bundle: verified, action: "update", record: { status: "active" }, existing: { status: "archived" }, changedFields: ["status"] })).toThrow(ForbiddenError)
    expect(() => enforceAbacWrite({ bundle: verified, action: "create", record: { status: "active" }, changedFields: ["status"] })).not.toThrow()
  })
})

describe("global capabilities honour conditional denies", () => {
  const allowExport = policy({ id: "allow", priority: 10, actions: [], capabilities: ["export"] })
  const denyEu = policy({ id: "deny", effect: "deny", priority: 100, actions: [], capabilities: ["export"], when: Predicate.eq("region", "eu") })

  it("treats a relevant conditional deny as matching for record-less checks", async () => {
    const verified = await bundle([allowExport, denyEu])
    expect(hasGlobalAbacCapability({ bundle: verified, capabilityKey: "export" })).toBe(false)
    expect(evaluateGlobalAbacCapability({ bundle: verified, capability: "export" })).toMatchObject({ allowed: false, reasonCode: "DENY_POLICY_MATCHED" })
    expect(createAbacAuthorizer(verified).canGlobalCapability("export")).toBe(false)
    expect(resolveGrantedGlobalCapabilities({ bundle: verified }).has("export")).toBe(false)
    expect(() => assertFrameworkAuthorization({
      facts: { scope: "application", ownerAuthority: false, impersonated: false },
      moduleKey: MODULE, action: "read", capabilityKey: "export", bundle: verified, evaluateAbacAction: false,
    })).toThrow(ForbiddenError)
  })

  it("keeps conditional allows non-granting and lower-tier denies shadowed", async () => {
    const conditionalAllow = policy({ id: "c", priority: 100, actions: [], capabilities: ["export"], when: Predicate.eq("region", "us") })
    expect(hasGlobalAbacCapability({ bundle: await bundle([conditionalAllow]), capabilityKey: "export" })).toBe(false)
    // A higher-tier conditional allow is UNKNOWN for a record whose region is
    // NULL, and that record is denied (the tier shadows the lower allow), so
    // the global grant must not be looser: found by the ABAC differential suite.
    const shadowed = await bundle([conditionalAllow, allowExport])
    expect(evaluateAbacRecordCapability({ bundle: shadowed, capability: "export", record: { region: null } }).allowed).toBe(false)
    expect(hasGlobalAbacCapability({ bundle: shadowed, capabilityKey: "export" })).toBe(false)
    expect(hasGlobalAbacCapability({ bundle: await bundle([{ ...conditionalAllow, priority: 10 }, allowExport]), capabilityKey: "export" })).toBe(true)
    const lowDeny = policy({ id: "low", effect: "deny", priority: 1, actions: [], capabilities: ["export"], when: Predicate.eq("region", "eu") })
    expect(hasGlobalAbacCapability({ bundle: await bundle([allowExport, lowDeny]), capabilityKey: "export" })).toBe(true)
    const neverDeny = policy({ id: "never", effect: "deny", priority: 100, actions: [], capabilities: ["export"], when: Predicate.alwaysFalse() })
    expect(hasGlobalAbacCapability({ bundle: await bundle([allowExport, neverDeny]), capabilityKey: "export" })).toBe(true)
  })
})

describe("record decisions agree with the three-valued query scope", () => {
  const denyForeign = policy({ id: "deny", effect: "deny", priority: 100, when: Predicate.neq("ownerId", "u1") })
  const allowAll = policy({ id: "allow", priority: 10 })
  const nullOwner = { id: "1", ownerId: null }

  it("denies actions and writes when a deny condition is UNKNOWN", async () => {
    const verified = await bundle([denyForeign, allowAll])
    expect(evaluatePredicate(nullOwner, buildActionScope({ bundle: verified, action: "update" }).filter)).toBe(false)
    expect(evaluateAbacRecordAction({ bundle: verified, action: "update", record: nullOwner })).toMatchObject({ allowed: false, reasonCode: "DENY_POLICY_MATCHED" })
    expect(evaluateWriteAccessForRecordDetailed({ policies: verified.policies, moduleKey: MODULE, action: "create", record: nullOwner }).allowed).toBe(false)
    expect(() => enforceAbacWrite({ bundle: verified, action: "create", record: nullOwner })).toThrow(ForbiddenError)
    expect(() => enforceAbacWrite({ bundle: verified, action: "update", record: nullOwner, changedFields: ["id"] })).toThrow(ForbiddenError)
    expect(evaluateAbacRecordAction({ bundle: verified, action: "update", record: { ownerId: "u1" } }).allowed).toBe(true)
  })

  it("lets an UNKNOWN higher-tier allow shadow lower tiers without granting", async () => {
    const shadowing = policy({ id: "shadow", priority: 100, when: Predicate.eq("ownerId", "u1") })
    const verified = await bundle([shadowing, allowAll])
    expect(evaluatePredicate(nullOwner, buildActionScope({ bundle: verified, action: "read" }).filter)).toBe(false)
    expect(evaluateAbacRecordAction({ bundle: verified, action: "read", record: nullOwner }).allowed).toBe(false)
    expect(evaluateAbacRecordAction({ bundle: verified, action: "read", record: { ownerId: "u2" } }).allowed).toBe(true)
  })

  it("applies UNKNOWN denies to record capabilities, field writes, and deny read masks", async () => {
    const denyCap = policy({ id: "dc", effect: "deny", priority: 100, actions: [], capabilities: ["export"], when: Predicate.neq("ownerId", "u1") })
    const allowCap = policy({ id: "ac", priority: 10, actions: [], capabilities: ["export"] })
    expect(evaluateAbacRecordCapability({ bundle: await bundle([denyCap, allowCap]), capability: "export", record: nullOwner }).allowed).toBe(false)

    const denySalaryWrite = policy({ id: "dw", effect: "deny", priority: 100, actions: ["update"], when: Predicate.neq("ownerId", "u1"), fieldAccess: { write: ["salary"] } })
    const allowWrite = policy({ id: "aw", priority: 100, actions: ["update"] })
    expect(() => assertPolicyWritableFields({ policies: [denySalaryWrite, allowWrite], moduleKey: MODULE, action: "update", record: { ownerId: null, salary: 1 }, changedFields: ["salary"] })).toThrow(ForbiddenError)

    const denySalaryRead = policy({ id: "dr", effect: "deny", actions: ["read"], when: Predicate.neq("ownerId", "u1"), fieldAccess: { read: { salary: "mask" } } })
    expect(resolveFieldReadOverrides({ policies: [denySalaryRead], moduleKey: MODULE, record: { ownerId: null, salary: 1 } }).salary).toBe("omit")
  })
})

describe("creates ignore UNKNOWN caused by absent fields", () => {
  const denyLocked = policy({ id: "deny", effect: "deny", priority: 10, actions: ["create", "update"], when: Predicate.eq("status", "locked") })
  const allowAll = policy({ id: "allow", priority: 1, actions: ["create", "update"] })

  it("allows a create whose body omits the field a deny condition reads", async () => {
    const verified = await bundle([denyLocked, allowAll])
    expect(() => enforceAbacWrite({ bundle: verified, action: "create", record: { id: "1", name: "n" } })).not.toThrow()
    expect(() => enforceAbacWrite({ bundle: verified, action: "create", record: { id: "1", status: "locked" } })).toThrow(ForbiddenError)
    // Updates keep the three-valued rule: the stored row has no status.
    expect(() => enforceAbacWrite({ bundle: verified, action: "update", record: { id: "1", name: "n" } })).toThrow(ForbiddenError)
  })

  it("does not let a higher-tier conditional allow on an omitted field shadow the create", async () => {
    const restricted = policy({ id: "r", priority: 10, actions: ["create"], when: Predicate.eq("kind", "special"), fieldAccess: { write: ["kind"] } })
    const open = policy({ id: "o", priority: 1, actions: ["create"] })
    const verified = await bundle([restricted, open])
    expect(() => enforceAbacWrite({ bundle: verified, action: "create", record: { id: "1", name: "n" }, changedFields: ["id", "name"] })).not.toThrow()
    expect(() => enforceAbacWrite({ bundle: verified, action: "create", record: { kind: "special", name: "n" }, changedFields: ["kind", "name"] })).toThrow(ForbiddenError)
  })

  it("still denies a create with an explicit null the deny condition reads", async () => {
    const denyForeign = policy({ id: "deny", effect: "deny", priority: 100, actions: ["create"], when: Predicate.neq("ownerId", "u1"), fieldAccess: { write: ["salary"] } })
    const allowCreate = policy({ id: "allow", priority: 100, actions: ["create"] })
    const verified = await bundle([denyForeign, allowCreate])
    expect(() => enforceAbacWrite({ bundle: verified, action: "create", record: { ownerId: null } })).toThrow(ForbiddenError)
    expect(() => assertPolicyWritableFields({ policies: verified.policies, moduleKey: MODULE, action: "create", record: { ownerId: null, salary: 1 }, changedFields: ["salary"] })).toThrow(ForbiddenError)
    expect(() => assertPolicyWritableFields({ policies: verified.policies, moduleKey: MODULE, action: "create", record: { salary: 1 }, changedFields: ["salary"] })).not.toThrow()
  })
})

describe("framework authorization binds the bundle to the module", () => {
  it("rejects a verified bundle for another module", async () => {
    const other = await bundle([{ ...policy({ id: "a" }), moduleKey: "other.module" }], "other.module")
    expect(() => assertFrameworkAuthorization({
      facts: { scope: "application", ownerAuthority: false, impersonated: false },
      moduleKey: MODULE, action: "read", bundle: other,
    })).toThrow(ForbiddenError)
  })
})

describe("strict policy date literals", () => {
  it.each([
    ["datetime", "2024-01-01T00:00:00"],
    ["datetime", "January 1, 2024"],
    ["datetime", "2024-01-01"],
    ["datetime", "2024-02-30T00:00:00Z"],
    ["datetime", "2024-01-01T24:00:00Z"],
    ["date", "2024-02-30"],
    ["date", "2024-13-01"],
    ["date", "January 1, 2024"],
  ] as const)("rejects %s %s", (type, value) => {
    expect(() => coercePolicyValue({ type, value })).toThrow(PolicyValidationError)
  })

  it("accepts RFC 3339 instants with an offset and calendar dates", () => {
    expect(coercePolicyValue({ type: "datetime", value: "2024-01-01T02:00:00+02:00" })).toEqual(new Date("2024-01-01T00:00:00.000Z"))
    expect(coercePolicyValue({ type: "datetime", value: "2024-02-29T00:00:00.5Z" })).toEqual(new Date("2024-02-29T00:00:00.500Z"))
    expect(coercePolicyValue({ type: "date", value: "2024-02-29" })).toEqual(new Date("2024-02-29T00:00:00.000Z"))
  })
})
