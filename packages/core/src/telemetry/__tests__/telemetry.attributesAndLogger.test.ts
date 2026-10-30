import { describe, expect, it, vi } from "vitest"
import { ValidationError } from "../../domain/errors"
import {
  boundedTelemetryAttributes, buildSafeTelemetryAttributes, createNoopTelemetry, createTelemetryLogger, emitTelemetry, isSensitiveTelemetryKey,
  MAX_TELEMETRY_LOG_ATTRIBUTES, TELEMETRY_REDACTED, SENSITIVE_TELEMETRY_KEY_PATTERNS, SENSITIVE_TELEMETRY_KEY_SEGMENTS,
  type TelemetryEvent, type TelemetryPort,
} from "../telemetry"

const event = (o: Partial<TelemetryEvent> = {}): TelemetryEvent => ({ name: "n", severity: "info", timestamp: new Date(1), attributes: { a: 1 }, ...o })

describe("telemetry constants", () => {
  it("pins the redaction marker, limits and key lists", () => {
    expect(TELEMETRY_REDACTED).toBe("[REDACTED]")
    expect(MAX_TELEMETRY_LOG_ATTRIBUTES).toBe(32)
    expect(SENSITIVE_TELEMETRY_KEY_PATTERNS).toEqual(["password", "passwd", "secret", "token", "authorization", "cookie", "apikey", "credential", "privatekey", "sessionid", "session", "jwt", "bearer", "signature"])
    expect(SENSITIVE_TELEMETRY_KEY_SEGMENTS).toEqual(["auth", "otp"])
    expect(Object.isFrozen(SENSITIVE_TELEMETRY_KEY_PATTERNS)).toBe(true)
    expect(Object.isFrozen(SENSITIVE_TELEMETRY_KEY_SEGMENTS)).toBe(true)
  })
})

describe("buildSafeTelemetryAttributes", () => {
  it("accepts a string of exactly 1024 bytes and rejects 1025", () => {
    const out = buildSafeTelemetryAttributes({ k: "a".repeat(1024) }, { k: "public" })
    expect(out.k).toHaveLength(1024)
    expect(Object.isFrozen(out)).toBe(true)
    expect(() => buildSafeTelemetryAttributes({ k: "a".repeat(1025) }, { k: "public" })).toThrow(new ValidationError("Telemetry attribute 'k' exceeds 1024 bytes"))
    expect(() => buildSafeTelemetryAttributes({ k: "é".repeat(513) }, { k: "public" })).toThrow("exceeds 1024 bytes")
    expect(buildSafeTelemetryAttributes({ k: "é".repeat(512) }, { k: "public" }).k).toHaveLength(512)
  })
  it("drops non-finite numbers and non-primitives", () => {
    const cls = { a: "public", b: "public", c: "public", d: "public", e: "public", f: "public" } as const
    expect(buildSafeTelemetryAttributes({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: 0, d: false, e: {}, f: null }, cls)).toEqual({ c: 0, d: false })
  })
})

describe("emitTelemetry", () => {
  it("does nothing without a port and swallows synchronous failures", () => {
    expect(() => emitTelemetry(undefined, event())).not.toThrow()
    expect(() => emitTelemetry({ emit: () => { throw new Error("x") } }, event())).not.toThrow()
  })
  it("hands the port a frozen copy and observes the returned promise", () => {
    let seen: TelemetryEvent | undefined
    const input = event()
    emitTelemetry({ emit: (e) => { seen = e } }, input)
    expect(seen).not.toBe(input)
    expect(seen).toEqual(input)
    expect(Object.isFrozen(seen)).toBe(true)
    expect(Object.isFrozen(seen!.attributes)).toBe(true)
    expect(seen!.attributes).not.toBe(input.attributes)
    const handler = vi.fn()
    const thenable = { catch: handler }
    emitTelemetry({ emit: () => thenable as never }, event())
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0]()).toBeUndefined()
    expect(() => emitTelemetry({ emit: () => ({}) as never }, event())).not.toThrow()
    expect(() => emitTelemetry({ emit: () => 0 as never }, event())).not.toThrow()
  })
  it("absorbs asynchronous failures", async () => {
    emitTelemetry({ emit: () => Promise.reject(new Error("late")) }, event())
    await new Promise(r => setTimeout(r, 5))
  })
})

describe("createNoopTelemetry", () => {
  it("returns a port whose emit is a silent function", () => {
    const port = createNoopTelemetry()
    expect(typeof port.emit).toBe("function")
    expect(port.emit(event())).toBeUndefined()
  })
})

describe("isSensitiveTelemetryKey", () => {
  it("matches patterns ignoring case and separators", () => {
    for (const k of ["password", "PASSWORD", "user_password", "access-token", "accessToken", "api.key", "API_KEY", "x apikey", "Set-Cookie", "session", "sessionId", "JWT", "bearer", "signature", "secret", "passwd", "credential", "privateKey", "authorization"]) expect(isSensitiveTelemetryKey(k)).toBe(true)
  })
  it("matches short secret words only as whole segments", () => {
    for (const k of ["auth", "AUTH", "OTP", "authHeader", "x-auth", "otp_code", "userOTP", "orderAuth", "level9Auth", "level2Otp", "XMLAuth", "my.auth.value", "my auth", "some_otp"]) expect(isSensitiveTelemetryKey(k)).toBe(true)
    for (const k of ["author", "AUTHOR", "footprint", "authority", "orderId", "orderID", "name", "", "oauthx", "dotp", "hotpot"]) expect(isSensitiveTelemetryKey(k)).toBe(false)
  })
  it("coerces non-string keys", () => {
    expect(isSensitiveTelemetryKey(12 as never)).toBe(false)
    expect(isSensitiveTelemetryKey({ toString: () => "password" } as never)).toBe(true)
  })
})

describe("boundedTelemetryAttributes", () => {
  it("keeps short and exactly-1024-byte strings and truncates beyond", () => {
    expect(boundedTelemetryAttributes("m").message).toBe("m")
    expect(boundedTelemetryAttributes("a".repeat(300)).message).toBe("a".repeat(300))
    expect(boundedTelemetryAttributes("a".repeat(1024)).message).toBe("a".repeat(1024))
    expect(boundedTelemetryAttributes("a".repeat(1025)).message).toBe(`${"a".repeat(1008)}…[truncated]`)
    expect(boundedTelemetryAttributes("m", { k: "b".repeat(1500) }).k).toBe(`${"b".repeat(1008)}…[truncated]`)
    expect(boundedTelemetryAttributes("é".repeat(600)).message).toBe(`${"é".repeat(504)}…[truncated]`)
    expect(boundedTelemetryAttributes("😀".repeat(300)).message).toBe(`${"😀".repeat(252)}…[truncated]`)
    expect(boundedTelemetryAttributes("é".repeat(512)).message).toBe("é".repeat(512))
    expect(boundedTelemetryAttributes(5 as never).message).toBe("5")
  })
  it("ignores non-object data", () => {
    for (const data of ["abc", 5, null, undefined, true] as never[]) expect(boundedTelemetryAttributes("m", data)).toEqual({ message: "m" })
    expect(Object.keys(boundedTelemetryAttributes("m", ["x"] as never))).toContain("0")
  })
  it("keeps primitives and drops everything else", () => {
    const out = boundedTelemetryAttributes("m", {
      s: "x", t: true, f: false, n: 3, z: 0, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, d: new Date(5), bad: new Date(Number.NaN),
      o: {}, arr: [], fn: () => 1, nul: null, und: undefined, big: 1n, sym: Symbol("s"),
    })
    expect(out).toEqual({ message: "m", s: "x", t: true, f: false, n: 3, z: 0, d: "1970-01-01T00:00:00.005Z" })
    expect(Object.getPrototypeOf(out)).toBeNull()
    expect(Object.isFrozen(out)).toBe(true)
  })
  it("redacts sensitive keys for primitive and date values only", () => {
    const out = boundedTelemetryAttributes("m", { password: "p", token: 5, secret: true, cookie: new Date(5), apiKey: { a: 1 }, jwt: null, bearer: Number.NaN, authKey: "k" })
    expect(out).toEqual({ message: "m", password: "[REDACTED]", token: "[REDACTED]", secret: "[REDACTED]", cookie: "[REDACTED]", bearer: "[REDACTED]", authKey: "[REDACTED]" })
  })
  it("skips message and over-long keys and caps the attribute count", () => {
    const key64 = "k".repeat(64)
    const out = boundedTelemetryAttributes("m", { message: "other", [key64]: 1, ["k".repeat(65)]: 2 })
    expect(out).toEqual({ message: "m", [key64]: 1 })
    const data: Record<string, number> = {}
    for (let i = 0; i < 40; i += 1) data[`k${i}`] = i
    const capped = boundedTelemetryAttributes("m", data)
    expect(Object.keys(capped)).toHaveLength(32)
    expect(capped["k30"]).toBe(30)
    expect(capped["k31"]).toBeUndefined()
    // dropped values do not use up the budget
    const sparse: Record<string, unknown> = {}
    for (let i = 0; i < 10; i += 1) sparse[`o${i}`] = {}
    for (let i = 0; i < 31; i += 1) sparse[`k${i}`] = i
    expect(Object.keys(boundedTelemetryAttributes("m", sparse))).toHaveLength(32)
  })
})

describe("createTelemetryLogger", () => {
  const collect = () => { const events: TelemetryEvent[] = []; return { events, port: { emit: (e: TelemetryEvent) => { events.push(e) } } satisfies TelemetryPort } }
  it("emits one event per severity with bounded attributes", () => {
    const { events, port } = collect()
    const when = new Date(7)
    const logger = createTelemetryLogger(port, "evt", () => when)
    logger.debug("d", { a: 1 })
    logger.info("i")
    logger.warn("w", { password: "x" })
    logger.error("e")
    expect(events.map(e => [e.name, e.severity, e.timestamp.getTime()])).toEqual([["evt", "debug", 7], ["evt", "info", 7], ["evt", "warn", 7], ["evt", "error", 7]])
    expect(events[0]!.attributes).toEqual({ message: "d", a: 1 })
    expect(events[2]!.attributes).toEqual({ message: "w", password: "[REDACTED]" })
    expect(Object.isFrozen(logger)).toBe(true)
  })
  it("falls back to the current time for an invalid clock and uses the default clock", () => {
    const { events, port } = collect()
    const before = Date.now()
    createTelemetryLogger(port, "evt", () => new Date(Number.NaN)).info("x")
    createTelemetryLogger(port, "evt", () => "now" as never).info("x")
    createTelemetryLogger(port, "evt").info("x")
    expect(events).toHaveLength(3)
    for (const e of events) { expect(e.timestamp).toBeInstanceOf(Date); expect(e.timestamp.getTime()).toBeGreaterThanOrEqual(before) }
  })
  it("is silent without a port and never throws", () => {
    expect(() => createTelemetryLogger(undefined, "evt").info("x")).not.toThrow()
    expect(() => createTelemetryLogger({ emit: () => { throw new Error("x") } }, "evt").error("x")).not.toThrow()
    expect(() => createTelemetryLogger({ emit: () => undefined }, "evt", () => { throw new Error("clock") }).error("x")).not.toThrow()
  })
})

describe("telemetry module initialisation", () => {
  it("builds the redaction marker and key lists each time the module is evaluated", async () => {
    vi.resetModules()
    const fresh = await import("../telemetry")
    expect(fresh.TELEMETRY_REDACTED).toBe("[REDACTED]")
    expect(fresh.SENSITIVE_TELEMETRY_KEY_PATTERNS).toEqual(["password", "passwd", "secret", "token", "authorization", "cookie", "apikey", "credential", "privatekey", "sessionid", "session", "jwt", "bearer", "signature"])
    expect(fresh.SENSITIVE_TELEMETRY_KEY_SEGMENTS).toEqual(["auth", "otp"])
    for (const word of fresh.SENSITIVE_TELEMETRY_KEY_PATTERNS) expect(fresh.isSensitiveTelemetryKey(`x_${word}_y`)).toBe(true)
    for (const word of fresh.SENSITIVE_TELEMETRY_KEY_SEGMENTS) expect(fresh.isSensitiveTelemetryKey(`x_${word}_y`)).toBe(true)
    expect(fresh.boundedTelemetryAttributes("m", { password: "p" }).password).toBe("[REDACTED]")
  })
})
