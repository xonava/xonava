// @ts-nocheck
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { forAllAsync, type Rng } from "../../../../../core/src/__tests__/differential/harness"
import { createFuzzFixture, type FaultOperation, type FuzzFixture } from "./fuzzFixture"
import { BASE_PATH, ORIGIN, createFuzzTransports, type FuzzRequest, type FuzzTransports } from "./fuzzTransports"
import { crudRequest, describeRequest, type FuzzFocus } from "./fuzzGenerators"
import { observationProblems, parityProblems, type Observation } from "./fuzzInvariants"

let fixture: FuzzFixture
let transports: FuzzTransports
let cursors: string[] = []

function collectCursors(value: unknown, out: string[]): void {
  if (value === null || typeof value !== "object") return
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && /cursor$/i.test(key) && item.startsWith("v1.")) out.push(item)
    else collectCursors(item, out)
  }
}

beforeAll(async () => {
  fixture = createFuzzFixture()
  transports = await createFuzzTransports({ crud: fixture.handlers })
  const first = await fixture.handlers.list(new Request(`${ORIGIN}${BASE_PATH}?limit=2`))
  expect(first.status).toBe(200)
  collectCursors(await first.json(), cursors)
  const second = await fixture.handlers.list(new Request(`${ORIGIN}${BASE_PATH}?limit=1&sorting=${encodeURIComponent('[{"id":"name","desc":true},{"id":"id"}]')}`))
  expect(second.status).toBe(200)
  collectCursors(await second.json(), cursors)
  expect(cursors.length).toBeGreaterThanOrEqual(2)
  fixture.seed()
})
afterAll(async () => { await transports.close() })

/** Sends one request through every adapter against a freshly seeded store and checks the invariants and parity. */
async function exercise(request: FuzzRequest, fault: FaultOperation | null = null): Promise<void> {
  const observations: Observation[] = []
  for (const transport of transports.transports) {
    fixture.seed()
    fixture.fault.operation = fault
    const rowsBefore = fixture.snapshot()
    const response = await transport.send(request)
    observations.push({ transport: transport.name, request, response, rowsBefore, rowsAfter: fixture.snapshot(), rows: new Map(Array.from(fixture.rows, ([id, row]) => [id, structuredClone(row)])), fault })
  }
  const problems = [...observations.flatMap(observationProblems), ...(fault === null ? parityProblems(observations) : [])]
  if (problems.length > 0) throw new Error(problems.join("\n"))
}

const options = { runs: 60, describe: describeRequest }
const generate = (focus: FuzzFocus) => (rng: Rng) => crudRequest(rng, { cursors }, focus)
const run = (request: FuzzRequest) => exercise(request)

describe("HTTP fuzzing: CRUD handlers through Express, Fastify and Hono", () => {
  it("survives hostile request bodies", () => forAllAsync("http fuzz CRUD hostile bodies", generate("body"), run, options), 120_000)
  it("survives hostile headers", () => forAllAsync("http fuzz CRUD hostile headers", generate("headers"), run, options), 120_000)
  it("survives hostile query strings and forged cursors", () => forAllAsync("http fuzz CRUD hostile query strings", generate("query"), run, options), 120_000)
  it("survives hostile path identifiers", () => forAllAsync("http fuzz CRUD hostile path identifiers", generate("path"), run, options), 120_000)
  it("never lets scope inputs cross a tenant boundary", () => forAllAsync("http fuzz CRUD scope inputs", generate("scope"), run, options), 120_000)
  it("survives mixed hostile requests", () => forAllAsync("http fuzz CRUD mixed requests", generate("any"), run, options), 120_000)
  it("answers injected faults with a generic 5xx and no write", () => forAllAsync(
    "http fuzz CRUD injected faults",
    (rng) => ({ request: crudRequest(rng, { cursors }, "any"), fault: rng.pick(["find", "insert", "update", "delete"] as const) }),
    ({ request, fault }) => exercise(request, fault),
    { runs: 60, describe: ({ request, fault }) => `fault ${fault}: ${describeRequest(request)}` },
  ), 120_000)
})
