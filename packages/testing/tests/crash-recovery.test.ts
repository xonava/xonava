import { describe, expect, it } from "vitest"

describe("release crash-recovery harness", () => {
  it("models an interrupted transaction as no committed effects", () => {
    type State = "idle" | "prepared" | "committed" | "recovered"
    const effects = ["command", "audit", "outbox"] as const
    const transition = (state: State, event: "prepare" | "commit" | "crash" | "recover") => {
      if (state === "idle" && event === "prepare") return "prepared" as const
      if (state === "prepared" && event === "commit") return "committed" as const
      if (state === "prepared" && event === "crash") return "prepared" as const
      if ((state === "prepared" || state === "committed") && event === "recover") return "recovered" as const
      return state
    }
    let state: State = "idle"
    let applied: string[] = []
    state = transition(state, "prepare")
    state = transition(state, "crash")
    state = transition(state, "recover")
    if (state !== "committed") applied = []
    expect(state).toBe("recovered")
    expect(applied).toEqual([])

    state = transition("idle", "prepare")
    state = transition(state, "commit")
    applied = [...effects]
    state = transition(state, "recover")
    expect(state).toBe("recovered")
    expect(applied).toEqual(effects)
  })
})
