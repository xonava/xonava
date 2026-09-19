import { describe } from "vitest"
import { runAbacInvariantTests } from "../src/abac-contracts"

describe("ABAC conformance suite", () => {
  runAbacInvariantTests()
})
