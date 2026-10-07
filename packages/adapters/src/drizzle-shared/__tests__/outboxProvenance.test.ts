import { describe, expect, it } from "vitest"
import { outboxProvenanceColumn } from "../outbox"

describe("framework-owned outbox provenance column", () => {
  const provenance = { format: "framework.authority-provenance", formatVersion: 1 }
  it("writes nothing when the table has no provenance column", () => {
    expect(outboxProvenanceColumn({ id: {} }, { provenance })).toEqual({})
  })
  it("writes JSON for JSON columns and a string for text columns", () => {
    expect(outboxProvenanceColumn({ provenance: { dataType: "json" } }, { provenance })).toEqual({ provenance })
    expect(outboxProvenanceColumn({ provenance: { dataType: "string" } }, { provenance })).toEqual({ provenance: JSON.stringify(provenance) })
  })
  it("writes null when the record carries no provenance", () => {
    expect(outboxProvenanceColumn({ provenance: { dataType: "json" } }, {})).toEqual({ provenance: null })
  })
})
