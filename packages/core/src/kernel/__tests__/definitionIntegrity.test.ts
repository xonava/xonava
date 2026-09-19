import { describe, expect, it } from "vitest"
import { cloneAndFreezeDefinition } from "../definitionIntegrity"

describe("cloneAndFreezeDefinition", () => {
  it("clones and freezes cyclic plain definitions without freezing the source", () => {
    const source: { child?: { parent?: unknown } } = { child: {} }
    source.child!.parent = source

    const result = cloneAndFreezeDefinition(source)

    expect(result).not.toBe(source)
    expect(result.child).not.toBe(source.child)
    expect(result.child?.parent).toBe(result)
    expect(Object.isFrozen(source)).toBe(false)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.child)).toBe(true)
  })

  it("rejects definitions deeper than the traversal bound", () => {
    let source: Record<string, unknown> = {}
    const root = source
    for (let index = 0; index < 65; index++) {
      source.child = {}
      source = source.child as Record<string, unknown>
    }

    expect(() => cloneAndFreezeDefinition(root)).toThrow("maximum nesting depth")
  })
})
