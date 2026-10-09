import { Predicate, evaluatePredicate, type PredicateNode, type PredicatePrimitive } from "core/domain"

/**
 * Shared differential harness for the normative predicate semantics: every
 * SQL compiler must select exactly the rows the core evaluator selects, for
 * the same generated predicates over the same dataset, including NULLs,
 * negation, mixed case, and non-ASCII ordering.
 */
export const NUMBERS = [null, -2, 0, 1, 2.5, 10] as const
// "a " and "a\t" catch PAD SPACE collations (MySQL utf8mb4_bin), which ignore trailing spaces.
export const STRINGS = [null, "", "a", "A", "ab", "Ab", "b", "é", "z", "😀", "a%_\\", "a ", "a\t"] as const
export const BOOLEANS = [null, true, false] as const

export interface ParityRow { id: number; n: number | null; s: string | null; b: boolean | null }

export function parityDataset(): ParityRow[] {
  const out: ParityRow[] = []
  let id = 1
  for (const n of NUMBERS) for (const s of STRINGS) for (const b of BOOLEANS) out.push({ id: id++, n, s, b })
  return out
}

export function predicateGenerator(seed: number): () => PredicateNode {
  let state = seed >>> 0
  const next = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
  const pick = <T>(values: readonly T[]): T => values[next() % values.length]!
  const nonNull = <T>(values: readonly (T | null)[]): T[] => values.filter((value): value is T => value !== null)
  const condition = (): PredicateNode => {
    const field = pick(["n", "s", "b"] as const)
    if (field === "b") return pick([
      () => Predicate.isTrue("b"), () => Predicate.isFalse("b"), () => Predicate.isNull("b"), () => Predicate.isNotNull("b"),
      () => Predicate.eq("b", pick(BOOLEANS)), () => Predicate.neq("b", pick(BOOLEANS)),
    ])()
    const values = (field === "n" ? NUMBERS : STRINGS) as readonly PredicatePrimitive[]
    const scalars = nonNull(values)
    const common = [
      () => Predicate.eq(field, pick(values)), () => Predicate.neq(field, pick(values)),
      () => Predicate.gt(field, pick(scalars)), () => Predicate.lt(field, pick(scalars)),
      () => Predicate.gte(field, pick(scalars)), () => Predicate.lte(field, pick(scalars)),
      () => Predicate.between(field, { from: pick(scalars), to: pick(scalars) }),
      () => Predicate.between(field, { from: pick(scalars) }),
      () => Predicate.in(field, [pick(values), pick(values), pick(values)]),
      () => Predicate.in(field, []),
      () => Predicate.isNull(field), () => Predicate.isNotNull(field),
    ]
    const strings = field === "s" ? [
      () => Predicate.contains("s", pick(nonNull(STRINGS))), () => Predicate.startsWith("s", pick(nonNull(STRINGS))),
      () => Predicate.endsWith("s", pick(nonNull(STRINGS))), () => Predicate.isEmpty("s"), () => Predicate.isNotEmpty("s"),
    ] : []
    return pick([...common, ...strings])()
  }
  const node = (depth: number): PredicateNode => {
    const roll = next() % 10
    if (depth >= 3 || roll < 4) return condition()
    if (roll < 6) return Predicate.not(node(depth + 1))
    const children = Array.from({ length: 1 + (next() % 3) }, () => node(depth + 1))
    return roll < 8 ? Predicate.and(...children) : Predicate.or(...children)
  }
  return () => node(0)
}

export const PARITY_SEED = 0x5eed2026
export const PARITY_ITERATIONS = 1500

/** Runs the differential check; returns up to `limit` human-readable mismatches. */
export async function findParityMismatches(select: (predicate: PredicateNode) => Promise<number[]>, limit = 5): Promise<string[]> {
  const data = parityDataset()
  const next = predicateGenerator(PARITY_SEED)
  const mismatches: string[] = []
  for (let iteration = 0; iteration < PARITY_ITERATIONS && mismatches.length < limit; iteration++) {
    const predicate = next()
    const expected = data.filter((row) => evaluatePredicate(row as unknown as Record<string, unknown>, predicate)).map((row) => row.id)
    const actual = [...await select(predicate)].sort((a, b) => a - b)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push(`${JSON.stringify(predicate)}\n  js:  ${JSON.stringify(expected)}\n  sql: ${JSON.stringify(actual)}`)
  }
  return mismatches
}
