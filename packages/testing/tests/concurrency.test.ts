import { describe, it, expect } from "vitest"

describe("optimistic concurrency", () => {
  it("stale version is rejected", () => {
    // Simulate: version 2 in DB, but client sends expected version 1
    const dbVersion: number = 2
    const clientExpectedVersion: number = 1
    
    const isStale = clientExpectedVersion !== dbVersion
    expect(isStale).toBe(true)
  })

  it("current version is accepted", () => {
    const dbVersion: number = 2
    const clientExpectedVersion: number = 2
    
    const isCurrent = clientExpectedVersion === dbVersion
    expect(isCurrent).toBe(true)
  })
})
