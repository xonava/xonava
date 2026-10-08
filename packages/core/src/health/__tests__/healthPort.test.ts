import { describe, expect, it } from "vitest"
import type { HealthCheckOptions, HealthComponent, HealthPort } from "../health"

describe("health port cancellation", () => {
  it("passes an optional signal and deadline to health checks and stays callable without them", async () => {
    const seen: (HealthCheckOptions | undefined)[] = []
    const component: HealthComponent = { key: "db", status: "healthy", critical: true, checkedAt: new Date(0) }
    const port: HealthPort = {
      checkLiveness: async (options) => { seen.push(options); return [component] },
      checkReadiness: async (options) => { seen.push(options); return options?.signal?.aborted ? [] : [component] },
    }
    const controller = new AbortController()
    controller.abort()
    const deadline = Date.now() + 1_000
    await expect(port.checkLiveness()).resolves.toHaveLength(1)
    await expect(port.checkReadiness({ signal: controller.signal, deadline })).resolves.toEqual([])
    expect(seen).toEqual([undefined, { signal: controller.signal, deadline }])

    const legacy: HealthPort = { checkLiveness: async () => [component], checkReadiness: async () => [] }
    await expect(legacy.checkReadiness({ deadline })).resolves.toEqual([])
  })
})
