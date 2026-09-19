import { describe, expect, it } from "vitest"

describe("release race harness", () => {
  it("allows only the current lease owner to commit", async () => {
    let owner: string | null = null
    let token: string | null = null
    const operations = ["worker-1", "worker-2", "worker-3", "worker-4"]
    const start = Promise.withResolvers<void>()
    const attempts = operations.map(async (worker, index) => {
      await start.promise
      for (let tick = 0; tick < (index === 1 ? 0 : index + 1); tick++) await Promise.resolve()
      if (owner === null) {
        owner = worker
        token = `token-${index + 1}`
      }
      return owner === worker && token === `token-${index + 1}`
    })
    start.resolve()
    expect(await Promise.all(attempts)).toEqual([false, true, false, false])
  })
})
