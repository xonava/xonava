/** The caller cancelled a read-model execution. Provider failures use the plan's partial-failure policy instead. */
export class ReadModelCancelledError extends Error {
  readonly kind = "cancelled" as const

  constructor(readonly reason?:unknown) {
    super("Read-model execution was cancelled")
    this.name = "ReadModelCancelledError"
  }
}

/** The read-wide absolute deadline elapsed. Deadlines always terminate the whole read. */
export class ReadModelDeadlineExceededError extends Error {
  readonly kind = "deadline-exceeded" as const

  constructor(readonly deadline:number) {
    super("Read-model execution deadline exceeded")
    this.name = "ReadModelDeadlineExceededError"
  }
}
