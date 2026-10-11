import { describe, expect, it } from "vitest"
import { forAllAsync, type Rng } from "./harness"
import { createExecutionContext } from "../../execution/executionContext"
import type { TelemetryEvent } from "../../telemetry/telemetry"

/** The execution context's fencedEffect: the lease is asserted before every effect, and an effect never runs on a lost lease. */

type Step = { lease: "ok" | "lost" | "throws-string"; effect: "returns" | "throws" | "throws-non-error" }

interface Case { steps: Step[]; withTelemetry: boolean; withSignal: boolean; withDeadline: boolean; withClock: boolean; withExecutionId: boolean }

describe("job execution context properties", () => {
  it("asserts the lease before each fenced effect and only runs the effect when the assertion passes", async () => {
    await forAllAsync("job context: fenced effects honour the lease assertion", (rng: Rng): Case => ({
      steps: Array.from({ length: 1 + rng.int(6) }, (): Step => ({ lease: rng.pick(["ok", "ok", "lost", "throws-string"] as const), effect: rng.pick(["returns", "returns", "throws", "throws-non-error"] as const) })),
      withTelemetry: rng.bool(), withSignal: rng.bool(), withDeadline: rng.bool(), withClock: rng.bool(), withExecutionId: rng.bool(),
    }), async (c) => {
      const events: TelemetryEvent[] = []
      const order: string[] = []
      let current: Step = c.steps[0]!
      const controller = new AbortController()
      const clock = { now: () => new Date(0), sleep: async () => undefined }
      const context = createExecutionContext({
        ...(c.withExecutionId ? { executionId: "exec-fixed" } : {}),
        jobId: "j", jobType: "t", jobVersion: 2, attempt: 3, tenantId: null, executionScope: { kind: "system", systemKey: "framework" }, correlationId: "corr",
        startedAt: new Date(5), ...(c.withTelemetry ? { telemetry: { emit: (event: TelemetryEvent) => { events.push(event); if (events.length % 3 === 0) throw new Error("sink down") } } } : {}),
        ...(c.withSignal ? { signal: controller.signal } : {}), ...(c.withDeadline ? { deadline: 99 } : {}), ...(c.withClock ? { clock } : {}),
        assertLease: async () => {
          order.push("assert")
          if (current.lease === "lost") throw new Error("lease lost")
          if (current.lease === "throws-string") throw "plain string rejection"
        },
      })
      if (c.withExecutionId) expect(context.executionId).toBe("exec-fixed")
      else expect(context.executionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(context).toMatchObject({ jobId: "j", jobType: "t", jobVersion: 2, attempt: 3, tenantId: null, correlationId: "corr", metadata: {} })
      expect("signal" in context).toBe(c.withSignal)
      expect("deadline" in context).toBe(c.withDeadline)
      expect("clock" in context).toBe(c.withClock)
      expect("telemetry" in context).toBe(c.withTelemetry)

      for (const [index, step] of c.steps.entries()) {
        current = step
        order.length = 0
        let ran = false
        const outcome = await context.fencedEffect.execute({
          effectName: "e", idempotencyKey: `k${index}`,
          fn: async () => {
            order.push("effect"); ran = true
            if (step.effect === "throws") throw new Error("effect failed")
            if (step.effect === "throws-non-error") throw { code: 7 }
            return index
          },
        }).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
        if (step.lease !== "ok") {
          expect(ran, `step ${index}: effect ran on a lost lease`).toBe(false)
          expect(order).toEqual(["assert"])
          expect(outcome.ok).toBe(false)
          expect(!outcome.ok && outcome.error).toEqual(step.lease === "lost" ? new Error("lease lost") : "plain string rejection")
        } else {
          expect(order).toEqual(["assert", "effect"])
          expect(ran).toBe(true)
          if (step.effect === "returns") expect(outcome).toEqual({ ok: true, value: index })
          else expect(outcome.ok).toBe(false)
          if (step.effect === "throws" && !outcome.ok) expect(outcome.error).toEqual(new Error("effect failed"))
          if (step.effect === "throws-non-error" && !outcome.ok) expect(outcome.error).toEqual({ code: 7 })
        }
      }
      if (c.withTelemetry) {
        const names = events.map((event) => event.name)
        const expected = c.steps.flatMap((step) => (step.lease !== "ok" ? ["execution.fenced_effect.lease_lost"] : ["execution.fenced_effect.started", step.effect === "returns" ? "execution.fenced_effect.succeeded" : "execution.fenced_effect.failed"]))
        expect(names).toEqual(expected)
        // Telemetry never carries the idempotency key or error text.
        expect(JSON.stringify(events)).not.toMatch(/k\d|lease lost|effect failed/)
      }
    }, { runs: 150 })
  })

  it("creates distinct execution ids when none is supplied", async () => {
    await forAllAsync("job context: generated execution ids are unique", (rng) => 2 + rng.int(20), async (count) => {
      const ids = new Set<string>()
      for (let index = 0; index < count; index++) {
        ids.add(createExecutionContext({ jobId: "j", jobType: "t", jobVersion: 1, attempt: 1, tenantId: null, executionScope: { kind: "system", systemKey: "framework" }, correlationId: "", startedAt: new Date(0), assertLease: async () => undefined }).executionId)
      }
      expect(ids.size).toBe(count)
    }, { runs: 50 })
  })
})
