import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createFuzzFixture, type FuzzFixture } from "./fuzzFixture"
import { createFuzzTransports, type FuzzRequest, type FuzzTransports } from "./fuzzTransports"
import { createCustomWriteHandler, customIdempotency, executed } from "./fuzzCustomHandler"
import { responseCode } from "./fuzzInvariants"

// Each case below was found by the HTTP fuzz suites and fixed; they pin the exact inputs.
let fixture: FuzzFixture
let transports: FuzzTransports
let customTransports: FuzzTransports
beforeAll(async () => {
  fixture = createFuzzFixture()
  transports = await createFuzzTransports({ crud: fixture.handlers })
  customTransports = await createFuzzTransports({ custom: createCustomWriteHandler() })
})
afterAll(async () => { await transports.close(); await customTransports.close() })

const json = new TextEncoder()
async function answers(request: FuzzRequest, custom = false): Promise<string[]> {
  const out: string[] = []
  for (const transport of (custom ? customTransports : transports).transports) {
    fixture.seed()
    customIdempotency.clear()
    executed.length = 0
    const response = await transport.send(request)
    out.push(`${transport.name}:${response.status}/${responseCode(response) ?? "-"}`)
  }
  return out
}
const same = (results: string[], expected: string) => expect(results.map((entry) => entry.split(":")[1])).toEqual([expected, expected, expected])

describe("HTTP fuzz regressions", () => {
  it("answers an idempotent DELETE or PATCH on Fastify like the other adapters (Fastify's params object is not a plain object)", async () => {
    same(await answers({ method: "DELETE", target: "/api/people/row-1", headers: [["idempotency-key", "k-1"]] }), "428/PRECONDITION_REQUIRED")
    same(await answers({ method: "DELETE", target: "/api/people/row-1", headers: [["idempotency-key", "k-1"], ["if-match", "1"]] }), "200/-")
    same(await answers({ method: "PATCH", target: "/api/people/row-1", headers: [["idempotency-key", "k-2"], ["if-match", "1"], ["content-type", "application/json"]], body: json.encode('{"name":"Ada L"}') }), "200/-")
  })

  it("answers an oversized body with 413 REQUEST_BODY_TOO_LARGE on every adapter, not Fastify's native error code", async () => {
    const body = new Uint8Array(1_048_577).fill(0x61)
    same(await answers({ method: "POST", target: "/api/people", headers: [["content-type", "application/json"]], body }), "413/REQUEST_BODY_TOO_LARGE")
  })

  it("lets the shared body checks judge an unparseable Content-Type on Fastify (empty value, comma list)", async () => {
    for (const contentType of ["", "application/json, text/plain"]) {
      same(await answers({ method: "POST", target: "/api/people", headers: [["content-type", contentType]], body: json.encode('{"name":"Ada"}') }), "415/UNSUPPORTED_MEDIA_TYPE")
    }
  })

  it("answers a request too large to fingerprint for idempotency with 400, not 500", async () => {
    const body = json.encode(`{"name":"Ada","extra":"${"x".repeat(1_048_400)}"}`)
    same(await answers({ method: "POST", target: "/api/custom/item-1", headers: [["content-type", "application/json"], ["idempotency-key", "k-3"]], body }, true), "400/VALIDATION_ERROR")
    expect(executed).toEqual([])
  })
})
