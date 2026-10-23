// @ts-nocheck
import { describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "@xonava/core/domain"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import { MODULE, idempotentConfig, makeWrite, type WriteHandlerArgs } from "./writeHandlerHarness"
import { canonicalRequestNormalization, trustedSession } from "./canonicalRequest"

const NAME_PATTERN = "/^[a-z][a-zA-Z0-9_-]{0,63}$/"

function bindingsFor(action: string): WriteHandlerArgs["requestNormalization"] {
  const base = canonicalRequestNormalization(trustedSession(), MODULE)
  return { ...base, routeBindings: { ...base.routeBindings, [action]: base.routeBindings.update } } as never
}

function build(action: string, extra: Partial<WriteHandlerArgs> = {}) {
  return makeWrite({ action: action as never, routeKey: "create", ...extra })
}

describe("write handler construction: action names", () => {
  it.each(["read", "manage"])("rejects the reserved business action %s with the exact message", (action) => {
    expect(() => build(action)).toThrow(new ConfigurationError(`Write handler for "${MODULE}" cannot use "${action}" as a business action; it is reserved`))
    expect(() => build(action)).toThrow(ConfigurationError)
  })

  it.each([
    ["starts with an uppercase letter", "Approve"],
    ["starts with a digit", "1approve"],
    ["is empty", ""],
    ["contains a space", "a b"],
    ["ends with an invalid character", "approve!"],
    ["starts with an invalid character", "!approve"],
    ["is 65 characters long", `a${"b".repeat(64)}`],
  ])("rejects a business action name that %s", (_label, action) => {
    expect(() => build(action)).toThrow(new ConfigurationError(`Write handler for "${MODULE}" has an invalid business action name; use ${NAME_PATTERN}`))
  })

  it("rejects an action that is not a string, even when its string form would pass", () => {
    expect(() => build(5 as never)).toThrow(`has an invalid business action name; use ${NAME_PATTERN}`)
    expect(() => build(new String("approve") as never)).toThrow(`has an invalid business action name; use ${NAME_PATTERN}`)
    expect(() => build({ toString: () => "approve" } as never)).toThrow(`has an invalid business action name; use ${NAME_PATTERN}`)
  })

  it.each(["approve", "a", `a${"b".repeat(63)}`, "mark-done_2", "aB9"])("accepts the business action %s", (action) => {
    expect(() => build(action)).not.toThrow()
  })

  it.each(["create", "update", "delete"])("accepts the CRUD action %s without a name check", (action) => {
    expect(() => makeWrite({ action: action as never, requestNormalization: bindingsFor(action) })).not.toThrow()
  })

  it("names the missing route binding", () => {
    expect(() => makeWrite({ routeKey: "nope" })).toThrow(`Write handler for "${MODULE}" action "create" has no route binding "nope"`)
    expect(() => makeWrite({ action: "approve" as never })).toThrow(`Write handler for "${MODULE}" action "approve" has no route binding "approve"`)
  })
})

describe("write handler construction: dependent configuration", () => {
  const cache = () => Promise.reject(new Error("unused"))

  it("rejects invalidateTags without required idempotency (idempotency absent, optional, or false)", () => {
    const message = `"${MODULE}" configures correctness-critical invalidateTags without required idempotency; durable cache invalidation needs idempotency`
    for (const scope of [{ scope: "platform" }, { scope: "platform", idempotency: {} }, { scope: "platform", idempotency: { required: false } }] as const) {
      expect(() => makeWrite({ invalidateTags: () => [], getCacheAdapter: cache, scope: scope as never })).toThrow(new ConfigurationError(message))
    }
  })

  it("rejects invalidateTags without a cache adapter provider", () => {
    expect(() => makeWrite(idempotentConfig({ invalidateTags: () => [] }))).toThrow(new ConfigurationError(`"${MODULE}" configures invalidateTags without a cache adapter provider`))
  })

  it("accepts invalidateTags with required idempotency and a cache adapter provider", () => {
    expect(() => makeWrite(idempotentConfig({ invalidateTags: () => [], getCacheAdapter: cache }))).not.toThrow()
  })

  it("rejects a durable audit guarantee without an outbox sink factory, and accepts it with one", () => {
    const definition = { audit: { auditGuarantee: "durable", action: "x", resourceType: "y", resolveResourceId: () => "z" } }
    expect(() => makeWrite({}, { definition })).toThrow(new ConfigurationError(`"${MODULE}" configures durable audit guarantee without an outboxSinkFactory`))
    expect(() => makeWrite({ outboxSinkFactory: () => ({ append: vi.fn() }) as never }, { definition })).not.toThrow()
    expect(() => makeWrite({}, { definition: { audit: { auditGuarantee: "best-effort", action: "x", resourceType: "y", resolveResourceId: () => "z" } } })).not.toThrow()
  })

  it("requires a resource identity and recovery function for required idempotency, individually", () => {
    const message = `Idempotent write handler "${MODULE}" requires a resource identity and recoverCommittedResponse`
    const scope = { scope: "platform", idempotency: { required: true } } as const
    expect(() => makeWrite({ scope })).toThrow(new ConfigurationError(message))
    expect(() => makeWrite({ scope, resolveResourceIdentity: () => ({ entity: "t", id: "1" }) })).toThrow(new ConfigurationError(message))
    expect(() => makeWrite({ scope, recoverCommittedResponse: async () => null })).toThrow(new ConfigurationError(message))
    expect(() => makeWrite(idempotentConfig())).not.toThrow()
    expect(() => makeWrite({ scope: { scope: "platform", idempotency: { required: false } } })).not.toThrow()
    expect(() => makeWrite({ scope: { scope: "platform" } })).not.toThrow()
  })

  it("exposes the factory as a function", () => {
    expect(typeof createFrameworkWriteHandler).toBe("function")
  })
})
