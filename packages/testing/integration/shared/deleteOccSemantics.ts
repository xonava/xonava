import { expect, it } from "vitest"
import { Predicate, type PredicateNode } from "@xonava/core/domain"

export type OccItem = { id: string; name: string; version: number }

/** The repository surface the delete/OCC rule is asserted through (the same on every database). */
export interface OccRepository {
  insert(data: Partial<OccItem>): Promise<unknown>
  findById(id: string): Promise<OccItem | null>
  delete(id: string, options?: { optimisticConcurrency?: { expectedVersion: number }; idempotent?: boolean }): Promise<void>
  deleteWhere(filter: PredicateNode, options?: { optimisticConcurrency?: { expectedVersion: number } }): Promise<{ deletedCount: number }>
}

export interface DeleteOccDriver {
  label: string
  repo: () => OccRepository
  reset: () => Promise<void>
  /** Raises the stored version by one, outside the repository. */
  bump: (id: string) => Promise<void>
}

const id = (value: string) => Predicate.eq("id", value)

/**
 * Rule (docs/spec/transactions-and-occ.md): a delete with an expected version on an existing row with a different version is
 * OPTIMISTIC_CONCURRENCY_FAILED and leaves the row; on a missing row it is NOT_FOUND. Identical on every database.
 */
export function defineDeleteOccSemantics(driver: DeleteOccDriver): void {
  const seed = async (rowId: string, bumps = 0) => {
    await driver.reset()
    const repo = driver.repo()
    await repo.insert({ id: rowId, name: "n", version: 1 })
    for (let i = 0; i < bumps; i++) await driver.bump(rowId)
    return repo
  }

  it(`delete with a stale version on an existing row is OPTIMISTIC_CONCURRENCY_FAILED and keeps the row (${driver.label})`, async () => {
    const repo = await seed("a", 1)
    await expect(repo.delete("a", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toMatchObject({ code: "OPTIMISTIC_CONCURRENCY_FAILED" })
    expect(await repo.findById("a")).toMatchObject({ id: "a", version: 2 })
  })

  it(`delete on a missing row is NOT_FOUND (${driver.label})`, async () => {
    const repo = await seed("a")
    await expect(repo.delete("missing", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it(`idempotent delete forgives a missing row but never a stale version (${driver.label})`, async () => {
    const repo = await seed("a", 1)
    await expect(repo.delete("missing", { optimisticConcurrency: { expectedVersion: 1 }, idempotent: true })).resolves.toBeUndefined()
    await expect(repo.delete("a", { optimisticConcurrency: { expectedVersion: 1 }, idempotent: true })).rejects.toMatchObject({ code: "OPTIMISTIC_CONCURRENCY_FAILED" })
    expect(await repo.findById("a")).not.toBeNull()
  })

  it(`delete with the current version removes the row (${driver.label})`, async () => {
    const repo = await seed("a", 1)
    await repo.delete("a", { optimisticConcurrency: { expectedVersion: 2 } })
    expect(await repo.findById("a")).toBeNull()
  })

  it(`deleteWhere follows the same rule (${driver.label})`, async () => {
    const repo = await seed("a", 1)
    await expect(repo.deleteWhere(id("a"), { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toMatchObject({ code: "OPTIMISTIC_CONCURRENCY_FAILED" })
    await expect(repo.deleteWhere(id("missing"), { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(await repo.findById("a")).not.toBeNull()
    await expect(repo.deleteWhere(id("a"), { optimisticConcurrency: { expectedVersion: 2 } })).resolves.toEqual({ deletedCount: 1 })
  })
}
