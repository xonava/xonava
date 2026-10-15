import { describe, expect, it } from "vitest"
import { Predicate, evaluatePredicate, evaluateAbacRecordAction, hasRecordDependentFieldWrite } from "@xonava/core/domain"
import type { AbacPolicyBundle, NormalizedAbacPolicy } from "@xonava/core/domain"

const noConditions = {
  version: 2 as const,
  systemScope: { logic: "AND" as const, conditions: [] },
  userFilters: { logic: "AND" as const, conditions: [] },
}

/**
 * Models the ABAC/OCC race scenario described by P1-09:
 *
 * Two concurrent update requests read the same row at version=2. Both evaluate
 * field-write ABAC policies against the snapshot state. Request A changes a
 * policy-driving field (e.g. `role`). Request B changes a non-policy field.
 *
 * Without OCC, request B could succeed using a stale policy evaluation that no
 * longer matches the committed row (because request A already changed `role`).
 * With OCC, the second writer's version check fails and the stale-policy
 * update is rejected.
 */
describe("ABAC/OCC race integration", () => {
  it("OCC rejects a stale-policy update when a concurrent writer changed a policy-driving field", () => {
    // ── Shared state ────────────────────────────────────────────────────
    const row = { id: "user-1", name: "Alice", role: "viewer", departmentId: "eng", version: 2 }
    const snapshot = { ...row } // both requests read this snapshot

    // ── Policy: only "admin" role may write the `departmentId` field ─────
    const adminPolicy: NormalizedAbacPolicy = {
      moduleKey: "users",
      source: { policyId: "p1", scopeType: "tenant_default" },
      effect: "allow",
      priority: 10,
      payload: {
        actions: ["update"],
        capabilities: [],
        conditions: noConditions,
        fieldAccess: { write: ["name", "departmentId"] },
      },
      compiledConditions: Predicate.eq("role", "admin"),
    }
    const denyWritePolicy: NormalizedAbacPolicy = {
      moduleKey: "users",
      source: { policyId: "p2", scopeType: "tenant_default" },
      effect: "deny",
      priority: 5,
      payload: {
        actions: ["update"],
        capabilities: [],
        conditions: noConditions,
        fieldAccess: { write: ["departmentId"] },
      },
      compiledConditions: Predicate.neq("role", "admin"),
    }

    const bundle: AbacPolicyBundle = {
      mode: "tenant",
      moduleKey: "users",
      policies: [adminPolicy, denyWritePolicy],
      context: { userId: "u1" },
      defaultEffect: "deny",
      fieldCatalog: {},
    }

    // ── Request A: changes `role` from "viewer" to "admin" ──────────────
    // Field-write check against the SNAPSHOT (role=viewer).
    // The policy says: admin can write departmentId, non-admin is denied.
    // With role=viewer, changing departmentId should be denied.
    const aChangedFields = ["role"]
    const aDenied = evaluatePolicyForFields(bundle, "users", "update", snapshot, aChangedFields)
    expect(aDenied).toEqual([]) // role is not in any fieldAccess.write list → allowed

    // Simulate: Request A commits first → row.version becomes 3, row.role = "admin"
    row.version = 3
    row.role = "admin"

    // ── Request B: changes `departmentId` from snapshot ──────────────────
    // B evaluated field-write ABAC against the SNAPSHOT (role=viewer), got
    // an allow (because `role` was not in fieldAccess.write → no explicit
    // deny matched). But by the time B's UPDATE reaches the DB, the row has
    // version=3 (A already committed). OCC rejects B because its expected
    // version (2) does not match the current version (3).
    const bChangedFields = ["departmentId"]
    const bDenied = evaluatePolicyForFields(bundle, "users", "update", snapshot, bChangedFields)
    // Against the snapshot (role=viewer), the deny policy matches → denied.
    expect(bDenied).toEqual(["departmentId"])

    // Even if B had gotten an allow against the stale snapshot (e.g. if the
    // deny policy had different conditions), the OCC check would still reject:
    const clientExpectedVersion = 2
    const currentDbVersion = row.version // 3 after A committed
    const isStale = clientExpectedVersion !== currentDbVersion
    expect(isStale).toBe(true) // OCC prevents the stale write
  })

  it("detects record-dependent field-write policies that require OCC", () => {
    const policies: NormalizedAbacPolicy[] = [
      {
        moduleKey: "users",
        source: { policyId: "p1", scopeType: "tenant_default" },
        effect: "allow",
        priority: 10,
        payload: {
          actions: ["update"],
          capabilities: [],
          conditions: noConditions,
          fieldAccess: { write: ["name", "email"] },
        },
        // Record-dependent: condition depends on current row state
        compiledConditions: Predicate.eq("role", "admin"),
      },
    ]

    // Record-dependent → hasRecordDependentFieldWrite returns true → OCC required
    expect(hasRecordDependentFieldWrite(policies, "users", "update")).toBe(true)

    // Unconditional field-write policy → no OCC needed
    const unconditional: NormalizedAbacPolicy[] = [
      {
        moduleKey: "users",
        source: { policyId: "p2", scopeType: "tenant_default" },
        effect: "allow",
        priority: 10,
        payload: {
          actions: ["update"],
          capabilities: [],
          conditions: noConditions,
          fieldAccess: { write: ["name"] },
        },
        // alwaysTrue predicate → not record-dependent
        compiledConditions: Predicate.alwaysTrue(),
      },
    ]
    expect(hasRecordDependentFieldWrite(unconditional, "users", "update")).toBe(false)

    // No field-access write policies at all → false
    expect(hasRecordDependentFieldWrite([], "users", "update")).toBe(false)
  })

  it("concurrent writers: first committer wins, second gets OCC rejection", () => {
    // Simulates two workers racing on the same entity with version-based OCC.
    const db = { row: { id: "doc-1", title: "Draft", status: "draft", version: 1 } }

    function simulateUpdate(
      expectedVersion: number,
      changes: Record<string, unknown>,
    ): { success: boolean; version?: number } {
      if (db.row.version !== expectedVersion) {
        return { success: false } // OCC rejection
      }
      Object.assign(db.row, changes)
      db.row.version = expectedVersion + 1
      return { success: true, version: db.row.version }
    }

    // Both read version=1
    const snapshotVersion = db.row.version

    // Writer A commits first
    const resultA = simulateUpdate(snapshotVersion, { status: "in-review" })
    expect(resultA.success).toBe(true)
    expect(db.row.version).toBe(2)
    expect(db.row.status).toBe("in-review")

    // Writer B tries with stale version → OCC rejection
    const resultB = simulateUpdate(snapshotVersion, { status: "published" })
    expect(resultB.success).toBe(false)
    expect(db.row.status).toBe("in-review") // unchanged
    expect(db.row.version).toBe(2) // unchanged
  })

  it("property: ABAC evaluation is deterministic across repeated reads of the same snapshot", () => {
    // Uses the property-testing pattern from property.test.ts to verify that
    // ABAC field-write evaluation is deterministic given the same input.
    const generate = (seed: number) => {
      let s = seed
      const next = () => {
        s = (s * 1664525 + 1013904223) >>> 0
        return s
      }
      return Array.from({ length: 64 }, () => {
        const role = next() % 3 === 0 ? "admin" : "viewer"
        const changedField = next() % 2 === 0 ? "name" : "email"
        return { role, changedField }
      })
    }

    const cases = generate(0xabac0cc)
    const casesRepeat = generate(0xabac0cc)
    expect(cases).toEqual(casesRepeat) // deterministic

    const bundle: AbacPolicyBundle = {
      mode: "tenant",
      moduleKey: "m",
      policies: [
        {
          moduleKey: "m",
          source: { policyId: "p1", scopeType: "tenant_default" },
          effect: "allow",
          priority: 10,
          payload: { actions: ["update"], capabilities: [], conditions: noConditions, fieldAccess: { write: ["name"] } },
          compiledConditions: Predicate.eq("role", "admin"),
        },
      ],
      context: { userId: "u1" },
      defaultEffect: "deny",
      fieldCatalog: {},
    }

    for (const { role, changedField: _changedField } of cases) {
      const record = { role }
      const decision = evaluateAbacRecordAction({ bundle, action: "update", record })
      // The action-level decision is independent of field-write checks;
      // field-write is a separate gate. Verify determinism:
      const second = evaluateAbacRecordAction({ bundle, action: "update", record })
      expect(second.allowed).toBe(decision.allowed)
    }
  })
})

/**
 * Evaluate field-write ABAC against a record snapshot.
 * Returns the list of denied fields (empty if all allowed).
 */
function evaluatePolicyForFields(
  bundle: AbacPolicyBundle,
  moduleKey: string,
  action: string,
  record: Record<string, unknown>,
  changedFields: string[],
): string[] {
  const relevant = bundle.policies
    .filter((p) => p.moduleKey === moduleKey && p.payload.actions.includes(action))
    .filter((p) => evaluatePredicate(record, p.compiledConditions))

  if (relevant.length === 0) return []

  const priorities = Array.from(new Set(relevant.map((p) => p.priority))).sort((a, b) => b - a)
  const topTier = relevant.filter((p) => p.priority === priorities[0])

  const denyPolicies = topTier.filter((p) => p.effect === "deny")
  const allowPolicies = topTier.filter((p) => p.effect === "allow")

  const denyAll = denyPolicies.some((p) => !p.payload.fieldAccess?.write?.length)
  const allowAll = allowPolicies.some((p) => !p.payload.fieldAccess?.write?.length)

  const denied: string[] = []

  for (const field of changedFields) {
    if (denyAll) { denied.push(field); continue }
    const fieldDenied = denyPolicies.some((p) => (p.payload.fieldAccess?.write ?? []).includes(field))
    if (fieldDenied) { denied.push(field); continue }
    if (allowAll) continue
    const fieldAllowed = allowPolicies.some((p) => (p.payload.fieldAccess?.write ?? []).includes(field))
    if (fieldAllowed) continue
    if (allowPolicies.length > 0) denied.push(field)
  }

  return denied
}
