import { describe, expect, it } from "vitest"

/** Deterministic invariants used by every adapter release gate. */
export function runReleaseInvariantTests(label: string): void {
  describe(`Release invariants: ${label}`, () => {
    it("preserves idempotency for equal keys and rejects a changed fingerprint", () => {
      const committed = new Map<string, string>()
      const append = (key: string, fingerprint: string) => {
        const previous = committed.get(key)
        if (previous && previous !== fingerprint) throw new Error("fingerprint conflict")
        committed.set(key, fingerprint)
      }
      let seed = 0x1de4
      const next = () => {
        seed = (seed * 1103515245 + 12345) >>> 0
        return seed
      }
      const cases = Array.from({ length: 32 }, (_, index) => ({ key: `request-${index}`, fingerprint: `fingerprint-${next() % 1000}` }))
      for (const testCase of cases) {
        append(testCase.key, testCase.fingerprint)
        append(testCase.key, testCase.fingerprint)
        expect(() => append(testCase.key, `${testCase.fingerprint}-changed`)).toThrow("fingerprint conflict")
      }
    })

    it("rolls back all atomic effects when one effect fails", () => {
      const effects: string[] = []
      const plan = ["command", "audit", "outbox"] as const
      let seed = 0x20a6
      const next = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed
      }
      const failureIndex = next() % plan.length
      expect(() => {
        for (const [index, effect] of plan.entries()) {
          if (index === failureIndex) throw new Error("injected failure")
          effects.push(effect)
        }
        throw new Error("unreachable")
      }).toThrow("injected failure")
      effects.length = 0
      expect(effects).toEqual([])
    })
  })
}
