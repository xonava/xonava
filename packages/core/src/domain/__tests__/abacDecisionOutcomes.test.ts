import { describe, expect, it } from "vitest"
import { bindAbacSecurityDigest } from "../abacBundleIntegrity"
import {
  evaluateAbacActionForCollection,
  evaluateAbacRecordAction,
  evaluateAbacRecordCapability,
  evaluateGlobalAbacCapability,
} from "../abacDecision"
import { Predicate, type PredicateNode } from "../predicate"
import type { AbacPolicyBundle, NormalizedAbacPolicy } from "../abacTypes"

const MODULE = "tenant.records"

function policy(args: {
  id: string
  effect?: "allow" | "deny"
  priority?: number
  actions?: string[]
  capabilities?: string[]
  when?: PredicateNode
  moduleKey?: string
  scopeRefId?: string | null
}): NormalizedAbacPolicy {
  const source: NormalizedAbacPolicy["source"] = { policyId: args.id, scopeType: "tenant_default" }
  if (args.scopeRefId !== undefined) source.scopeRefId = args.scopeRefId
  return {
    source,
    moduleKey: args.moduleKey ?? MODULE,
    effect: args.effect ?? "allow",
    priority: args.priority ?? 10,
    payload: {
      actions: args.actions ?? ["read"],
      capabilities: args.capabilities ?? ["cap"],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
      },
    },
    compiledConditions: args.when ?? Predicate.alwaysTrue(),
  }
}

function bundle(policies: NormalizedAbacPolicy[], defaultEffect: "allow" | "deny" = "deny") {
  return bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: MODULE,
    policies,
    context: { userId: "user-1" },
    defaultEffect,
    fieldCatalog: {},
  } satisfies Omit<AbacPolicyBundle, "securityDigest">)
}

describe("record action decisions", () => {
  it("denies with NO_RELEVANT_POLICY when no policy names the action", async () => {
    const denied = await bundle([policy({ id: "a", actions: ["read"] })], "deny")
    expect(evaluateAbacRecordAction({ bundle: denied, action: "delete", record: {} })).toEqual({
      allowed: false,
      target: { type: "action", key: "delete" },
      reasonCode: "NO_RELEVANT_POLICY",
      evidence: [],
    })
  })

  it("excludes policies from other modules even when their action matches", async () => {
    const other = await bundle([policy({ id: "other", moduleKey: "other.module" })], "deny")
    expect(evaluateAbacRecordAction({ bundle: other, action: "read", record: {} })).toMatchObject({
      allowed: false,
      reasonCode: "NO_RELEVANT_POLICY",
      evidence: [],
    })
  })

  it("grants with priority and evidence for a matched allow", async () => {
    const b = await bundle([policy({ id: "a", priority: 5 })])
    const decision = evaluateAbacRecordAction({ bundle: b, action: "read", record: {} })
    expect(decision).toEqual({
      allowed: true,
      target: { type: "action", key: "read" },
      reasonCode: "ALLOW_POLICY_MATCHED",
      priority: 5,
      evidence: [{ policyId: "a", effect: "allow", priority: 5, scopeType: "tenant_default" }],
    })
  })

  it("keeps scopeRefId in evidence, including an explicit null", async () => {
    const withRef = await bundle([policy({ id: "a", scopeRefId: "ref-1" })])
    expect(evaluateAbacRecordAction({ bundle: withRef, action: "read", record: {} }).evidence).toEqual([
      { policyId: "a", effect: "allow", priority: 10, scopeType: "tenant_default", scopeRefId: "ref-1" },
    ])
    const withNull = await bundle([policy({ id: "a", scopeRefId: null })])
    expect(evaluateAbacRecordAction({ bundle: withNull, action: "read", record: {} }).evidence).toEqual([
      { policyId: "a", effect: "allow", priority: 10, scopeType: "tenant_default", scopeRefId: null },
    ])
  })

  it("lists the deciding deny first and the other matched allow after it", async () => {
    const b = await bundle([
      policy({ id: "allow", effect: "allow", priority: 10 }),
      policy({ id: "deny", effect: "deny", priority: 10 }),
    ])
    const decision = evaluateAbacRecordAction({ bundle: b, action: "read", record: {} })
    expect(decision.allowed).toBe(false)
    expect(decision.reasonCode).toBe("DENY_POLICY_MATCHED")
    expect(decision.priority).toBe(10)
    expect(decision.evidence.map((e) => e.policyId)).toEqual(["deny", "allow"])
    expect(decision.evidence[0]?.effect).toBe("deny")
    expect(decision.evidence[1]?.effect).toBe("allow")
  })

  it("does not grant on an unknown allow and reports the tier without evidence", async () => {
    const b = await bundle([policy({ id: "a", priority: 7, when: Predicate.eq("status", "open") })])
    expect(evaluateAbacRecordAction({ bundle: b, action: "read", record: {} })).toEqual({
      allowed: false,
      target: { type: "action", key: "read" },
      reasonCode: "NO_POLICY_MATCHED",
      priority: 7,
      evidence: [],
    })
  })

  it("ignores a policy whose condition is false and falls to the deny default", async () => {
    const b = await bundle([policy({ id: "a", when: Predicate.eq("status", "open") })], "deny")
    expect(evaluateAbacRecordAction({ bundle: b, action: "read", record: { status: "closed" } })).toEqual({
      allowed: false,
      target: { type: "action", key: "read" },
      reasonCode: "NO_POLICY_MATCHED",
      evidence: [],
    })
  })
})

describe("global capability decisions", () => {
  it("grants only through an unconditional allow", async () => {
    const unconditional = await bundle([policy({ id: "a" })])
    expect(evaluateGlobalAbacCapability({ bundle: unconditional, capability: "cap" })).toEqual({
      allowed: true,
      target: { type: "capability", key: "cap" },
      reasonCode: "ALLOW_POLICY_MATCHED",
      priority: 10,
      evidence: [{ policyId: "a", effect: "allow", priority: 10, scopeType: "tenant_default" }],
    })
    const conditional = await bundle([policy({ id: "a", when: Predicate.eq("status", "open") })])
    expect(evaluateGlobalAbacCapability({ bundle: conditional, capability: "cap" })).toMatchObject({
      allowed: false,
      reasonCode: "NO_POLICY_MATCHED",
    })
  })

  it("treats a deny that is not statically false as matching, and a statically false deny as not matching", async () => {
    const liveDeny = await bundle([policy({ id: "d", effect: "deny", when: Predicate.eq("status", "x") })], "deny")
    expect(evaluateGlobalAbacCapability({ bundle: liveDeny, capability: "cap" })).toMatchObject({
      allowed: false,
      reasonCode: "DENY_POLICY_MATCHED",
      evidence: [{ policyId: "d", effect: "deny", priority: 10, scopeType: "tenant_default" }],
    })
    const falseDeny = await bundle([policy({ id: "d", effect: "deny", when: Predicate.alwaysFalse() })], "deny")
    expect(evaluateGlobalAbacCapability({ bundle: falseDeny, capability: "cap" })).toMatchObject({
      allowed: false,
      reasonCode: "NO_POLICY_MATCHED",
      evidence: [],
    })
  })

  it("does not grant through a statically false allow", async () => {
    const b = await bundle([policy({ id: "a", when: Predicate.alwaysFalse() })], "deny")
    expect(evaluateGlobalAbacCapability({ bundle: b, capability: "cap" })).toMatchObject({
      allowed: false,
      reasonCode: "NO_POLICY_MATCHED",
    })
  })

  it("selects capability policies only for the bundle module", async () => {
    const b = await bundle([policy({ id: "other", moduleKey: "other.module" })])
    expect(evaluateGlobalAbacCapability({ bundle: b, capability: "cap" })).toEqual({
      allowed: false,
      target: { type: "capability", key: "cap" },
      reasonCode: "NO_RELEVANT_POLICY",
      evidence: [],
    })
  })
})

describe("record capability decisions", () => {
  it("selects by capability, not action, and ignores other modules", async () => {
    const b = await bundle([
      policy({ id: "wrongCap", capabilities: ["other"] }),
      policy({ id: "rightCap", actions: ["write"], capabilities: ["cap"] }),
      policy({ id: "foreign", moduleKey: "other.module", actions: ["read"], capabilities: ["cap"] }),
    ])
    expect(evaluateAbacRecordCapability({ bundle: b, capability: "cap", record: {} })).toEqual({
      allowed: true,
      target: { type: "capability", key: "cap" },
      reasonCode: "ALLOW_POLICY_MATCHED",
      priority: 10,
      evidence: [{ policyId: "rightCap", effect: "allow", priority: 10, scopeType: "tenant_default" }],
    })
    const foreignOnly = await bundle([policy({ id: "foreign", moduleKey: "other.module" })])
    expect(evaluateAbacRecordCapability({ bundle: foreignOnly, capability: "cap", record: {} })).toMatchObject({
      allowed: false,
      reasonCode: "NO_RELEVANT_POLICY",
    })
  })

  it("keeps scopeRefId in capability evidence", async () => {
    const b = await bundle([policy({ id: "a", scopeRefId: "ref-2" })])
    expect(evaluateAbacRecordCapability({ bundle: b, capability: "cap", record: {} }).evidence).toEqual([
      { policyId: "a", effect: "allow", priority: 10, scopeType: "tenant_default", scopeRefId: "ref-2" },
    ])
  })
})

describe("collection decisions", () => {
  it("denies a deny-only action as statically denied", async () => {
    const b = await bundle([policy({ id: "d", effect: "deny" })], "deny")
    expect(evaluateAbacActionForCollection({ bundle: b, action: "read" })).toMatchObject({
      allowed: false,
      reasonCode: "STATICALLY_DENIED",
      evidence: [],
    })
  })

  it("denies a conditional deny with no allow as statically denied", async () => {
    const b = await bundle([policy({ id: "d", effect: "deny", when: Predicate.eq("x", 1) })], "deny")
    expect(evaluateAbacActionForCollection({ bundle: b, action: "read" })).toMatchObject({
      allowed: false,
      reasonCode: "STATICALLY_DENIED",
      evidence: [],
    })
  })

  it("reports the action scope and evidence for policies of this action and module only", async () => {
    const b = await bundle([
      policy({ id: "allow", scopeRefId: "r1" }),
      policy({ id: "deny", effect: "deny", when: Predicate.eq("x", 1) }),
      policy({ id: "otherAction", actions: ["write"] }),
      policy({ id: "otherModule", moduleKey: "other.module" }),
    ])
    const decision = evaluateAbacActionForCollection({ bundle: b, action: "read" })
    expect(decision.allowed).toBe(true)
    expect(decision.reasonCode).toBe("ACTION_SCOPE_AVAILABLE")
    expect(decision.evidence).toEqual([
      { policyId: "allow", effect: "allow", priority: 10, scopeType: "tenant_default", scopeRefId: "r1" },
      { policyId: "deny", effect: "deny", priority: 10, scopeType: "tenant_default" },
    ])
  })

})
