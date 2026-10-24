import { describe, expect, it } from "vitest"
import { ConfigurationError, Predicate } from "../../domain"
import {
  createAuthorizedExecutionPlan,
  createPrivilegedAuthorizationTrace,
  isAuthorizedExecutionPlan,
} from "../authorizedExecutionPlan"

const authenticated = { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } as const
const human = { id: "user-1", kind: "human", authentication: authenticated } as const
const scope = { kind: "tenant", tenantId: "tenant-1" } as const
const observedAt = "2026-09-10T00:00:00.000Z"
const policy = { key: "policy", version: 1, digest: "a".repeat(64) }

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity: { actor: human, subject: human }, scope, action: "records.read", operationKind: "read",
    readableFields: new Set(["id"]), writableFields: new Set(["status"]), obligations: [], dynamicFacts: [], policy,
    ...overrides,
  }
}

function build(overrides: Record<string, unknown> = {}) {
  return createAuthorizedExecutionPlan(base(overrides) as never)
}

function failure(overrides: Record<string, unknown>): unknown {
  try {
    build(overrides)
  } catch (error) {
    return error
  }
  throw new Error("expected createAuthorizedExecutionPlan to throw")
}

function expectConfig(overrides: Record<string, unknown>, message: string): void {
  const error = failure(overrides)
  expect(error).toBeInstanceOf(ConfigurationError)
  expect((error as Error).message).toBe(message)
}

const fact = { factKey: "fact", version: "1", observedAt }
const mutationFact = { ...fact, revalidation: { kind: "transaction-check", checkKey: "check" } }

describe("isAuthorizedExecutionPlan", () => {
  it("accepts only frozen plans issued by createAuthorizedExecutionPlan", () => {
    const issued = build()
    expect(isAuthorizedExecutionPlan(issued)).toBe(true)
    expect(isAuthorizedExecutionPlan({ ...issued })).toBe(false)
    expect(isAuthorizedExecutionPlan(Object.freeze({ ...issued }))).toBe(false)
    expect(isAuthorizedExecutionPlan(base())).toBe(false)
    for (const value of [null, undefined, "plan", 5, true, {}, []]) expect(isAuthorizedExecutionPlan(value)).toBe(false)
  })
})

describe("plan immutability", () => {
  it("freezes every level of the issued plan", () => {
    const issued = build({
      obligations: [{ kind: "audit", action: "a" }],
      dynamicFacts: [{ ...fact, revalidation: { kind: "transaction-check", checkKey: "k" } }],
      mandatoryResourcePredicate: Predicate.eq("tenantId", "tenant-1"),
    })
    for (const value of [
      issued, issued.identity, issued.identity.actor, issued.identity.actor.authentication, issued.identity.subject,
      issued.scope, issued.obligations, issued.obligations[0], issued.dynamicFacts, issued.dynamicFacts[0],
      issued.dynamicFacts[0]?.revalidation, issued.policy, issued.readableFields, issued.writableFields, issued.mandatoryResourcePredicate,
    ]) expect(Object.isFrozen(value)).toBe(true)
  })

  it("snapshots field sets so later changes to the source sets are ignored", () => {
    const readable = new Set(["id", "name"])
    const writable = new Set(["status"])
    const issued = build({ readableFields: readable, writableFields: writable })
    readable.add("secret")
    writable.delete("status")
    expect(issued.readableFields.size).toBe(2)
    expect(issued.readableFields.has("secret")).toBe(false)
    expect(issued.writableFields.has("status")).toBe(true)
    expect([...issued.readableFields]).toEqual(["id", "name"])
    expect([...issued.readableFields.keys()]).toEqual(["id", "name"])
    expect([...issued.readableFields.values()]).toEqual(["id", "name"])
    expect([...issued.readableFields.entries()]).toEqual([["id", "id"], ["name", "name"]])
    const seen: string[] = []
    issued.readableFields.forEach((value, key, set) => { seen.push(`${value}:${key}:${set === issued.readableFields}`) })
    expect(seen).toEqual(["id:id:true", "name:name:true"])
  })

  it("copies identity, scope and policy so the caller's objects stay mutable and independent", () => {
    const identity = { actor: human, subject: human }
    const ownScope = { kind: "tenant", tenantId: "tenant-1" }
    const ownPolicy = { key: "policy", version: 1, digest: "b".repeat(64) }
    const issued = build({ identity, scope: ownScope, policy: ownPolicy })
    expect(issued.identity).not.toBe(identity)
    expect(issued.scope).not.toBe(ownScope)
    expect(issued.policy).not.toBe(ownPolicy)
    expect(Object.isFrozen(identity)).toBe(false)
    expect(Object.isFrozen(ownScope)).toBe(false)
    expect(Object.isFrozen(ownPolicy)).toBe(false)
    expect(() => { (issued.policy as { key: string }).key = "other" }).toThrow(TypeError)
  })
})

describe("plan envelope validation", () => {
  it("rejects a plan that is not an object", () => {
    for (const value of [null, undefined, 0, "", "plan", false, 5, true]) {
      let error: unknown
      try { createAuthorizedExecutionPlan(value as never) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as Error).message).toBe("Authorization plan must be an object")
    }
  })

  it("requires a non-blank string action", () => {
    for (const action of ["", " ", "\t\n", 5, undefined, null]) expectConfig({ action }, "Authorization plan action must be non-empty")
    expect(build({ action: " x " }).action).toBe(" x ")
  })

  it("requires a read or mutation operation kind", () => {
    for (const operationKind of ["delete", "READ", "", undefined, null, 1]) expectConfig({ operationKind }, "Authorization plan operation kind is invalid")
    expect(build({ operationKind: "read" }).operationKind).toBe("read")
    expect(build({ operationKind: "mutation" }).operationKind).toBe("mutation")
  })

  it("rejects a missing or malformed actor and subject as configuration errors", () => {
    for (const identity of [undefined, null, {}, { subject: human }, { actor: human }, { actor: human, subject: null }, { actor: null, subject: human }]) {
      const error = failure({ identity })
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as Error).message).toBe("principal.kind is invalid")
    }
    const blank = failure({ identity: { actor: { ...human, id: " " }, subject: human } })
    expect((blank as Error).message).toBe("principal.id must be non-empty")
    const blankSubject = failure({ identity: { actor: human, subject: { ...human, id: "" } } })
    expect((blankSubject as Error).message).toBe("principal.id must be non-empty")
  })

  it("rejects an invalid execution scope", () => {
    expect(() => build({ scope: { kind: "tenant" } })).toThrow(/invalid tenant scope/)
    expect(() => build({ scope: undefined })).toThrow(/invalid ExecutionScope/)
    expect(() => build({ scope: { kind: "galaxy" } })).toThrow()
  })

  it("requires both field permissions to be sets", () => {
    const message = "Authorization plan field permissions must be sets"
    const notSets = [undefined, null, {}, [], "id", { has: () => true }, { [Symbol.iterator]: () => [][Symbol.iterator]() }, { has: true, [Symbol.iterator]: () => [][Symbol.iterator]() }]
    for (const value of notSets) {
      expectConfig({ readableFields: value }, message)
      expectConfig({ writableFields: value }, message)
    }
    expectConfig({ readableFields: {}, writableFields: {} }, message)
  })

  it("requires every readable and writable field name to be a non-blank string", () => {
    const message = "Authorization plan field permissions must contain non-empty strings"
    for (const bad of ["", " ", "\t", 5, null, undefined]) {
      expectConfig({ readableFields: new Set(["id", bad]) }, message)
      expectConfig({ writableFields: new Set(["id", bad]) }, message)
    }
    expect(build({ readableFields: new Set<string>(), writableFields: new Set<string>() }).readableFields.size).toBe(0)
  })

  it("requires obligations and dynamic facts to be arrays", () => {
    const message = "Authorization plan obligations and facts must be arrays"
    for (const bad of [undefined, null, {}, "x", new Set()]) {
      expectConfig({ obligations: bad }, message)
      expectConfig({ dynamicFacts: bad }, message)
    }
  })

  it("requires complete policy evidence", () => {
    const message = "Authorization plan policy evidence is invalid"
    for (const bad of [undefined, null]) expectConfig({ policy: bad }, message)
    for (const key of [5, "", " ", undefined, null]) expectConfig({ policy: { ...policy, key } }, message)
    for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1", undefined, null]) expectConfig({ policy: { ...policy, version } }, message)
    for (const digest of [5, "", " ", "\n", undefined, null]) expectConfig({ policy: { ...policy, digest } }, message)
    expect(build({ policy: { ...policy, version: 1 } }).policy.version).toBe(1)
    expect(build({ policy: { ...policy, version: Number.MAX_SAFE_INTEGER } }).policy.version).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe("obligation validation", () => {
  it("rejects non-object obligations", () => {
    for (const bad of [null, undefined, 5, "audit", true]) expectConfig({ obligations: [bad] }, "Authorization plan obligation is invalid")
  })

  it("requires a non-blank audit action", () => {
    const message = "Authorization plan audit obligation action must be non-empty"
    for (const action of ["", " ", "\n", 5, undefined, null]) expectConfig({ obligations: [{ kind: "audit", action }] }, message)
    expect(build({ obligations: [{ kind: "audit", action: "export" }] }).obligations).toEqual([{ kind: "audit", action: "export" }])
  })

  it("accepts only the mfa and recent-authentication step-up requirements", () => {
    for (const requirement of ["sms", "", "MFA", undefined, null, 1]) expectConfig({ obligations: [{ kind: "step-up", requirement }] }, "Authorization plan step-up requirement is invalid")
    expect(build({ obligations: [{ kind: "step-up", requirement: "mfa" }] }).obligations).toEqual([{ kind: "step-up", requirement: "mfa" }])
    expect(build({ obligations: [{ kind: "step-up", requirement: "recent-authentication" }] }).obligations).toEqual([{ kind: "step-up", requirement: "recent-authentication" }])
  })

  it("requires step-up maxAgeSeconds to be a positive safe integer when present", () => {
    const message = "Authorization plan step-up maxAgeSeconds must be a positive safe integer"
    for (const maxAgeSeconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "60", null]) {
      expectConfig({ obligations: [{ kind: "step-up", requirement: "mfa", maxAgeSeconds }] }, message)
    }
    for (const maxAgeSeconds of [1, 60, Number.MAX_SAFE_INTEGER, undefined]) {
      expect(build({ obligations: [{ kind: "step-up", requirement: "mfa", maxAgeSeconds }] }).obligations).toHaveLength(1)
    }
    expect(build({ obligations: [{ kind: "step-up", requirement: "mfa", maxAgeSeconds: 1 }] }).obligations[0]).toEqual({ kind: "step-up", requirement: "mfa", maxAgeSeconds: 1 })
  })

  it("requires mask obligations to name a non-blank field and a known strategy", () => {
    const message = "Authorization plan mask obligation is invalid"
    expectConfig({ obligations: [{ kind: "other", field: "ssn", strategy: "redact" }] }, message)
    expectConfig({ obligations: [{ field: "ssn", strategy: "redact" }] }, message)
    for (const field of ["", " ", "\t", 5, undefined, null]) expectConfig({ obligations: [{ kind: "mask", field, strategy: "redact" }] }, message)
    for (const strategy of ["encrypt", "", "REDACT", undefined, null, 1]) expectConfig({ obligations: [{ kind: "mask", field: "ssn", strategy }] }, message)
    for (const strategy of ["redact", "partial", "hash"]) {
      expect(build({ obligations: [{ kind: "mask", field: "ssn", strategy }] }).obligations).toEqual([{ kind: "mask", field: "ssn", strategy }])
    }
  })

  it("reports the invalid obligation even when earlier ones are valid", () => {
    expectConfig({ obligations: [{ kind: "audit", action: "a" }, { kind: "audit", action: " " }] }, "Authorization plan audit obligation action must be non-empty")
  })
})

describe("dynamic fact validation", () => {
  const invalid = "Authorization plan dynamic fact evidence is invalid"

  it("rejects non-object facts and facts with blank or non-string keys, versions or timestamps", () => {
    for (const bad of [null, undefined, 5, "fact", true]) expectConfig({ dynamicFacts: [bad] }, invalid)
    for (const factKey of ["", " ", "\t", 5, undefined, null]) expectConfig({ dynamicFacts: [{ ...fact, factKey }] }, invalid)
    for (const version of ["", " ", "\n", 5, undefined, null]) expectConfig({ dynamicFacts: [{ ...fact, version }] }, invalid)
    for (const at of ["2026-09-10", "2026-09-10T00:00:00+02:00", "not a date", "", 5, undefined, null, new Date(observedAt)]) {
      expectConfig({ dynamicFacts: [{ ...fact, observedAt: at }] }, invalid)
    }
  })

  it("allows read plans to carry facts without a revalidation strategy and still validates strategies they do carry", () => {
    const issued = build({ dynamicFacts: [fact, { ...fact, factKey: "second", revalidation: { kind: "transaction-check", checkKey: "k" } }] })
    expect(issued.dynamicFacts.map((item) => item.factKey)).toEqual(["fact", "second"])
    expect(issued.dynamicFacts[0]?.revalidation).toBeUndefined()
    expectConfig({ dynamicFacts: [{ ...fact, revalidation: { kind: "transaction-check", checkKey: " " } }] }, "Authorization plan transaction check key must be non-empty")
  })

  it("rejects mutation plans whose facts lack a revalidation strategy", () => {
    expectConfig({ operationKind: "mutation", dynamicFacts: [fact] }, 'Mutable authorization fact "fact" has no mutation revalidation strategy')
    expectConfig({ operationKind: "mutation", dynamicFacts: [mutationFact, { ...fact, factKey: "second" }] }, 'Mutable authorization fact "second" has no mutation revalidation strategy')
    expect(build({ operationKind: "mutation", dynamicFacts: [mutationFact] }).dynamicFacts).toHaveLength(1)
    expect(build({ operationKind: "mutation", dynamicFacts: [] }).dynamicFacts).toHaveLength(0)
  })

  it("validates mutation-predicate revalidation fields", () => {
    const message = "Authorization plan mutation predicate field must be non-empty"
    for (const field of ["", " ", "\t", 5, undefined, null]) {
      expectConfig({ dynamicFacts: [{ ...fact, revalidation: { kind: "mutation-predicate", field, expectedValue: 1 } }] }, message)
    }
    const issued = build({ operationKind: "mutation", dynamicFacts: [{ ...fact, revalidation: { kind: "mutation-predicate", field: "owner", expectedValue: undefined } }] })
    expect(issued.dynamicFacts[0]?.revalidation).toEqual({ kind: "mutation-predicate", field: "owner", expectedValue: undefined })
  })

  it("validates transaction-check keys", () => {
    const message = "Authorization plan transaction check key must be non-empty"
    for (const checkKey of ["", " ", "\n", 5, undefined, null]) {
      expectConfig({ dynamicFacts: [{ ...fact, revalidation: { kind: "transaction-check", checkKey } }] }, message)
    }
  })

  it("validates lease-grant checks", () => {
    const message = "Authorization plan lease grant check is invalid"
    const lease = { kind: "lease-grant-check", grantId: "grant-1", version: "3" }
    for (const grantId of ["", " ", "\t", 5, undefined, null]) expectConfig({ dynamicFacts: [{ ...fact, revalidation: { ...lease, grantId } }] }, message)
    for (const version of ["", " ", "\n", 5, undefined, null]) expectConfig({ dynamicFacts: [{ ...fact, revalidation: { ...lease, version } }] }, message)
    for (const kind of ["other", "", undefined, null, 1]) expectConfig({ dynamicFacts: [{ ...fact, revalidation: { ...lease, kind } }] }, message)
    const issued = build({ operationKind: "mutation", dynamicFacts: [{ ...fact, revalidation: lease }] })
    expect(issued.dynamicFacts[0]?.revalidation).toEqual(lease)
  })
})

describe("authorization value snapshots", () => {
  function predicateOf(value: unknown): unknown {
    return build({ mandatoryResourcePredicate: value }).mandatoryResourcePredicate
  }
  function configMessage(value: unknown): string {
    try { predicateOf(value) } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError)
      return (error as Error).message
    }
    throw new Error("expected a throw")
  }

  it("keeps null, undefined, boolean, number and string leaves, including undefined-valued keys", () => {
    const result = predicateOf({ a: undefined, b: null, c: false, d: 0, e: "", f: "x", g: 1.5, h: [undefined, null, true] }) as Record<string, unknown>
    expect({ ...result }).toStrictEqual({ a: undefined, b: null, c: false, d: 0, e: "", f: "x", g: 1.5, h: [undefined, null, true] })
    expect("a" in result).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.h)).toBe(true)
    expect(Array.isArray(result.h)).toBe(true)
    expect(Object.getPrototypeOf(result)).toBeNull()
  })

  it("accepts null-prototype data objects and arrays but no other prototypes", () => {
    const nullProto = Object.create(null) as Record<string, unknown>
    nullProto.x = 1
    expect({ ...(predicateOf(nullProto) as object) }).toStrictEqual({ x: 1 })
    const message = "Authorization plan must contain only data values"
    expect(configMessage(new (class Custom { x = 1 })())).toBe(message)
    expect(configMessage({ nested: new Map() })).toBe(message)
    expect(configMessage({ nested: new Set() })).toBe(message)
    expect(configMessage({ nested: /re/ })).toBe(message)
  })

  it("rejects functions, cycles and accessors with specific errors", () => {
    expect(configMessage({ f: () => 1 })).toBe("Authorization plan must contain acyclic data values")
    expect(configMessage({ f: Symbol("s") })).toBe("Authorization plan must contain acyclic data values")
    expect(configMessage({ f: 10n })).toBe("Authorization plan must contain acyclic data values")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(configMessage(cyclic)).toBe("Authorization plan must contain acyclic data values")
    const cyclicArray: unknown[] = []
    cyclicArray.push(cyclicArray)
    expect(configMessage(cyclicArray)).toBe("Authorization plan must contain acyclic data values")
    const getter = Object.defineProperty({}, "x", { get: () => 1, enumerable: true })
    expect(configMessage(getter)).toBe("Authorization plan cannot contain accessors")
    const accessorArray: unknown[] = [1]
    Object.defineProperty(accessorArray, "0", { get: () => 1, enumerable: true })
    expect(configMessage(accessorArray)).toBe("Authorization plan cannot contain accessors")
    expect(configMessage([1, accessorArray])).toBe("Authorization plan cannot contain accessors")
  })

  it("allows a shared, non-cyclic reference to appear more than once", () => {
    const shared = { a: 1 }
    const result = predicateOf({ x: shared, y: shared, z: [shared, shared] }) as { x: unknown; y: unknown; z: unknown[] }
    expect({ ...(result.x as object) }).toStrictEqual({ a: 1 })
    expect({ ...(result.y as object) }).toStrictEqual({ a: 1 })
    expect(result.z).toHaveLength(2)
    const sharedArray = [1]
    expect(predicateOf([sharedArray, sharedArray])).toEqual([[1], [1]])
  })

  it("snapshots Dates as immutable copies and rejects invalid ones", () => {
    const source = new Date("2026-09-10T12:00:00.000Z")
    const predicate = Predicate.eq("createdAt", source as never)
    const result = (predicateOf(predicate) as { value: Date }).value
    expect(result).toBeInstanceOf(Date)
    expect(result).not.toBe(source)
    expect(result.getTime()).toBe(source.getTime())
    expect(Object.isFrozen(result)).toBe(true)
    source.setTime(0)
    expect(result.getTime()).toBe(Date.parse("2026-09-10T12:00:00.000Z"))
    const mutators = [
      "setDate", "setFullYear", "setHours", "setMilliseconds", "setMinutes", "setMonth", "setSeconds", "setTime",
      "setUTCDate", "setUTCFullYear", "setUTCHours", "setUTCMilliseconds", "setUTCMinutes", "setUTCMonth", "setUTCSeconds",
    ] as const
    for (const name of mutators) {
      let thrown: unknown
      try { (result[name] as (value: number) => number)(1) } catch (error) { thrown = error }
      expect(thrown).toBeInstanceOf(TypeError)
      expect((thrown as Error).message).toBe("Authorization plan Date values are immutable")
      const descriptor = Object.getOwnPropertyDescriptor(result, name)
      expect(descriptor?.enumerable).toBe(false)
      expect(descriptor?.configurable).toBe(false)
      expect(descriptor?.writable).toBe(false)
    }
    expect(Object.keys(result)).toEqual([])
    expect(result.getTime()).toBe(Date.parse("2026-09-10T12:00:00.000Z"))
    expect(configMessage(new Date(Number.NaN))).toBe("Authorization plan cannot contain an invalid Date")
    expect(configMessage({ nested: [new Date("invalid")] })).toBe("Authorization plan cannot contain an invalid Date")
  })

  it("allows exactly 10000 snapshot nodes and rejects 10001", () => {
    const limit = "Authorization plan exceeds snapshot limits"
    expect((predicateOf(new Array<number>(9_999).fill(1)) as unknown[]).length).toBe(9_999)
    expect(configMessage(new Array<number>(10_000).fill(1))).toBe(limit)
    expect(configMessage(new Array<number>(20_000).fill(1))).toBe(limit)
    expect(configMessage({ items: new Array<number>(10_000).fill(1) })).toBe(limit)
    const manyFacts = Array.from({ length: 2_500 }, (_, index) => ({ ...fact, factKey: `f${index}` }))
    let error: unknown
    try { build({ dynamicFacts: manyFacts }) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(ConfigurationError)
    expect((error as Error).message).toBe(limit)
    expect(build({ dynamicFacts: manyFacts.slice(0, 1_000) }).dynamicFacts).toHaveLength(1_000)
  })

  it("allows a leaf at nesting depth 64", () => {
    let node: unknown = { v: 1 }
    for (let index = 0; index < 63; index += 1) node = { c: node }
    expect(predicateOf(node)).toBeDefined()
    let deeper: unknown = { v: 1 }
    for (let index = 0; index < 64; index += 1) deeper = { c: deeper }
    expect(() => predicateOf(deeper)).toThrow()
    let arrays: unknown = [1]
    for (let index = 0; index < 63; index += 1) arrays = [arrays]
    expect(predicateOf(arrays)).toBeDefined()
  })

  it("snapshots dynamic fact values the same way", () => {
    const issued = build({ operationKind: "mutation", dynamicFacts: [{ ...fact, revalidation: { kind: "mutation-predicate", field: "owner", expectedValue: new Date("2026-01-01T00:00:00.000Z") } }] })
    const expected = (issued.dynamicFacts[0]?.revalidation as { expectedValue: Date }).expectedValue
    expect(expected).toBeInstanceOf(Date)
    expect(Object.isFrozen(expected)).toBe(true)
    expect(() => expected.setTime(1)).toThrow("Authorization plan Date values are immutable")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    let error: unknown
    try { build({ operationKind: "mutation", dynamicFacts: [{ ...fact, revalidation: { kind: "mutation-predicate", field: "owner", expectedValue: cyclic } }] }) } catch (caught) { error = caught }
    expect((error as Error).message).toBe("Authorization plan must contain acyclic data values")
  })
})

describe("createPrivilegedAuthorizationTrace", () => {
  it("projects the exact decision trace without a predicate", () => {
    const issued = build({
      action: "records.update", operationKind: "mutation", scope: { kind: "platform", platformKey: "p1" },
      readableFields: new Set(["a", "b", "c"]), writableFields: new Set(["a"]),
      obligations: [{ kind: "audit", action: "x" }, { kind: "mask", field: "b", strategy: "redact" }],
      dynamicFacts: [mutationFact, { ...mutationFact, factKey: "other" }],
      policy: { key: "pol", version: 7, digest: "d".repeat(64) },
    })
    const trace = createPrivilegedAuthorizationTrace(issued)
    expect(trace).toStrictEqual({
      action: "records.update", scopeKind: "platform", policyKey: "pol", policyVersion: 7, predicateApplied: false,
      readableFieldCount: 3, writableFieldCount: 1, obligationKinds: ["audit", "mask"], dynamicFactKeys: ["fact", "other"],
    })
    expect(Object.isFrozen(trace)).toBe(true)
    expect(Object.isFrozen(trace.obligationKinds)).toBe(true)
    expect(Object.isFrozen(trace.dynamicFactKeys)).toBe(true)
  })

  it("reports predicateApplied when a mandatory predicate exists", () => {
    const withPredicate = createPrivilegedAuthorizationTrace(build({ mandatoryResourcePredicate: Predicate.eq("tenantId", "tenant-1") }))
    expect(withPredicate.predicateApplied).toBe(true)
    expect(withPredicate.scopeKind).toBe("tenant")
    expect(withPredicate.obligationKinds).toEqual([])
    expect(withPredicate.dynamicFactKeys).toEqual([])
    expect(createPrivilegedAuthorizationTrace(build()).predicateApplied).toBe(false)
  })
})
