import { describe, it, expect } from "vitest"
import { assertPolicyWritableFields, resolveFieldQueryAccess, resolveFieldQueryDenials, resolveFieldReadOverrides } from "../fieldAccess"
import { Predicate } from "../predicate"
import type { NormalizedAbacPolicy } from "../abacTypes"

function makePolicy(overrides: Partial<NormalizedAbacPolicy> = {}): NormalizedAbacPolicy {
  return {
    source: { policyId: "test-policy", scopeType: "tenant_default" },
    moduleKey: "test.module",
    effect: "allow",
    priority: 100,
    payload: {
      actions: ["update"],
      capabilities: [],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
      },
    },
    compiledConditions: Predicate.alwaysTrue(),
    ...overrides,
  }
}

describe("assertPolicyWritableFields", () => {
  it("allow + no write list → all fields allowed", () => {
    expect(() =>
      assertPolicyWritableFields({
        policies: [makePolicy({ payload: { ...makePolicy().payload, actions: ["update"] } })],
        moduleKey: "test.module",
        action: "update",
        record: { name: "test" },
        changedFields: ["name", "email"],
      }),
    ).not.toThrow()
  })

  it("allow + write list → only listed fields allowed", () => {
    expect(() =>
      assertPolicyWritableFields({
        policies: [
          makePolicy({
            payload: {
              ...makePolicy().payload,
              actions: ["update"],
              fieldAccess: { write: ["name"] },
            },
          }),
        ],
        moduleKey: "test.module",
        action: "update",
        record: { name: "ok", email: "not-allowed" },
        changedFields: ["name", "email"],
      }),
    ).toThrow()
  })

  it("deny + no write list → no fields allowed", () => {
    expect(() =>
      assertPolicyWritableFields({
        policies: [
          makePolicy({
            effect: "deny",
            payload: { ...makePolicy().payload, actions: ["update"] },
          }),
        ],
        moduleKey: "test.module",
        action: "update",
        record: { name: "test" },
        changedFields: ["name"],
      }),
    ).toThrow()
  })

  it("deny + write list → listed fields denied", () => {
    expect(() =>
      assertPolicyWritableFields({
        policies: [
          makePolicy({
            effect: "deny",
            priority: 200,
            payload: {
              ...makePolicy().payload,
              actions: ["update"],
              fieldAccess: { write: ["email"] },
            },
          }),
          makePolicy({
            payload: {
              ...makePolicy().payload,
              actions: ["update"],
            },
          }),
        ],
        moduleKey: "test.module",
        action: "update",
        record: { name: "ok", email: "blocked" },
        changedFields: ["name", "email"],
      }),
    ).toThrow()
  })
})

describe("resolveFieldReadOverrides", () => {
  it("returns empty overrides when no fieldAccess.read policies match", () => {
    const result = resolveFieldReadOverrides({
      policies: [
        makePolicy({
          payload: {
            ...makePolicy().payload,
            actions: ["read"],
          },
        }),
      ],
      moduleKey: "test.module",
      record: { name: "test" },
    })
    expect(result).toEqual({})
  })

  it("returns omit for fields in deny policy fieldAccess.read", () => {
    const result = resolveFieldReadOverrides({
      policies: [
        makePolicy({
          effect: "deny",
          priority: 200,
          payload: {
            ...makePolicy().payload,
            actions: ["read"],
            fieldAccess: { read: { ssn: "omit" as const } },
          },
        }),
      ],
      moduleKey: "test.module",
      record: { name: "test", ssn: "123-45-6789" },
    })
    expect(result).toEqual({ ssn: "omit" })
  })
})

function makeReadPolicy(fieldAccess: NonNullable<NormalizedAbacPolicy["payload"]["fieldAccess"]>, overrides: Partial<NormalizedAbacPolicy> = {}): NormalizedAbacPolicy {
  return makePolicy({
    payload: { ...makePolicy().payload, actions: ["read"], fieldAccess },
    ...overrides,
  })
}

/** Every field a caller could reference in the query tests below. */
const QUERY_FIELDS = ["name", "salary", "ssn"]

describe("resolveFieldQueryAccess", () => {
  it("query-denies a masked field by default across filter/search/sort", () => {
    const result = resolveFieldQueryAccess({
      policies: [makeReadPolicy({ read: { salary: "mask" } })],
      moduleKey: "test.module",
      fields: QUERY_FIELDS,
    })
    expect(result.filter).not.toContain("salary")
    expect(result.search).not.toContain("salary")
    expect(result.sort).not.toContain("salary")
  })

  it("re-allows a masked field when an explicit query grant targets the mode", () => {
    const result = resolveFieldQueryAccess({
      policies: [makeReadPolicy({ read: { salary: "mask" }, query: { filter: ["salary"] } })],
      moduleKey: "test.module",
      fields: QUERY_FIELDS,
    })
    expect(result.filter).toContain("salary")
    expect(result.search).not.toContain("salary")
    expect(result.sort).not.toContain("salary")
  })

  it("allows an unrestricted field (explicit read allow) in every mode", () => {
    const result = resolveFieldQueryAccess({
      policies: [makeReadPolicy({ read: { name: "allow" } })],
      moduleKey: "test.module",
      fields: QUERY_FIELDS,
    })
    expect(result.filter).toContain("name")
    expect(result.search).toContain("name")
    expect(result.sort).toContain("name")
  })

  it("treats deny-effect read entries as query-denied even when the deny lists a grant", () => {
    const denied = resolveFieldQueryAccess({
      policies: [makeReadPolicy({ read: { ssn: "allow" } }, { effect: "deny", priority: 200 })],
      moduleKey: "test.module",
      fields: QUERY_FIELDS,
    })
    expect(denied.filter).not.toContain("ssn")
    const granted = resolveFieldQueryAccess({
      policies: [makeReadPolicy({ read: { ssn: "allow" }, query: { search: ["ssn"] } }, { effect: "deny", priority: 200 })],
      moduleKey: "test.module",
      fields: QUERY_FIELDS,
    })
    // Deny-effect policies never grant query access to a field they omit.
    expect(granted.search).not.toContain("ssn")
    expect(granted.filter).not.toContain("ssn")
  })

  it("ignores policies for other modules", () => {
    const result = resolveFieldQueryAccess({
      policies: [makeReadPolicy({ read: { salary: "mask" } }, { moduleKey: "other.module" })],
      moduleKey: "test.module",
      fields: QUERY_FIELDS,
    })
    expect(result.filter).toEqual([])
    expect(result.search).toEqual([])
    expect(result.sort).toEqual([])
  })
})

describe("resolveFieldQueryDenials", () => {
  it("denies masked fields until a matching query grant re-allows the mode", () => {
    const denials = resolveFieldQueryDenials({
      policies: [makeReadPolicy({ read: { salary: "mask" }, query: { filter: ["salary"] } })],
      moduleKey: "test.module",
      fields: QUERY_FIELDS,
    })
    expect(denials.filter).not.toContain("salary")
    expect(denials.search).toContain("salary")
    expect(denials.sort).toContain("salary")
  })

  it("keeps unrestricted fields out of the denial lists", () => {
    const denials = resolveFieldQueryDenials({
      policies: [makeReadPolicy({ read: { name: "allow", salary: "mask" } })],
      moduleKey: "test.module",
      fields: QUERY_FIELDS,
    })
    expect(denials.filter).not.toContain("name")
    expect(denials.filter).toContain("salary")
  })
})
