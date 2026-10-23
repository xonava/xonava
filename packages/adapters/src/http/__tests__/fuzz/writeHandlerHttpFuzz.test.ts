// @ts-nocheck
import { afterAll, beforeAll, describe, it } from "vitest"
import { forAllAsync } from "../../../../../core/src/__tests__/differential/harness"
import { createCustomWriteHandler, customIdempotency, executed } from "./fuzzCustomHandler"
import { createFuzzTransports, type FuzzRequest, type FuzzTransports } from "./fuzzTransports"
import { customWriteRequest, describeRequest } from "./fuzzGenerators"
import { observationProblems, parityProblems, type Observation } from "./fuzzInvariants"

let transports: FuzzTransports
beforeAll(async () => { transports = await createFuzzTransports({ custom: createCustomWriteHandler() }) })
afterAll(async () => { await transports.close() })

async function exercise(request: FuzzRequest): Promise<void> {
  const observations: Observation[] = []
  for (const transport of transports.transports) {
    executed.length = 0
    customIdempotency.clear()
    const response = await transport.send(request)
    // The "state" of this handler is the list of executed mutations.
    observations.push({ transport: transport.name, request, response, rowsBefore: "[]", rowsAfter: JSON.stringify(executed), rows: new Map(), fault: null })
  }
  const problems = [...observations.flatMap(observationProblems), ...parityProblems(observations)]
  if (problems.length > 0) throw new Error(problems.join("\n"))
}

describe("HTTP fuzzing: a custom write handler through Express, Fastify and Hono", () => {
  it("survives hostile bodies, headers, parameters and queries", () => forAllAsync(
    "http fuzz custom write handler",
    (rng) => customWriteRequest(rng),
    exercise,
    { runs: 60, describe: describeRequest },
  ), 120_000)
})
