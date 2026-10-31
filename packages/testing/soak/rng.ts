/** Small seeded generator (mulberry32) so a soak run can be replayed with SOAK_SEED. */
export interface SoakRng {
  next(): number
  int(maxExclusive: number): number
  between(min: number, max: number): number
  bool(probability?: number): boolean
  pick<T>(values: readonly T[]): T
}

export function createSoakRng(seed: number): SoakRng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    between: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bool: (probability = 0.5) => next() < probability,
    pick: (values) => values[Math.floor(next() * values.length)]!,
  }
}
