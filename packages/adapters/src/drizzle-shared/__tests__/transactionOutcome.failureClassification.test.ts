import { describe, expect, it } from "vitest"
import { ConflictError, FrameworkCoreError, PersistenceError, RetryablePersistenceError, TimeoutError, TransactionRolledBackError } from "@xonava/core/domain"
import { MAX_STATEMENT_TIMEOUT_MS, classifyTransactionFailure, statementTimeoutMs, transactionTimeoutError } from "../transactionOutcome"

const chain = (levels: number, leaf: Record<string, unknown>): Record<string, unknown> => {
  let current: Record<string, unknown> = leaf
  for (let i = 0; i < levels; i++) current = { cause: current }
  return current
}

describe("classifyTransactionFailure: definite rollback at commit", () => {
  it("maps PostgreSQL 40001 and 40P01 to TransactionRolledBackError with exact details", () => {
    for (const code of ["40001", "40P01"]) {
      const result = classifyTransactionFailure({ code }, "postgresql", true)
      expect(result).toBeInstanceOf(TransactionRolledBackError)
      expect(result.message).toBe("The transaction was rolled back at commit")
      expect(result.details).toStrictEqual({ dialect: "postgresql", providerCode: code })
    }
  })
  it("maps MySQL ER_LOCK_DEADLOCK and 1213 (string-converted providerCode)", () => {
    const named = classifyTransactionFailure({ code: "ER_LOCK_DEADLOCK" }, "mysql", true)
    expect(named).toBeInstanceOf(TransactionRolledBackError)
    expect(named.details).toStrictEqual({ dialect: "mysql", providerCode: "ER_LOCK_DEADLOCK" })
    const numeric = classifyTransactionFailure({ errno: 1213 }, "mysql", true)
    expect(numeric).toBeInstanceOf(TransactionRolledBackError)
    expect(numeric.details).toStrictEqual({ dialect: "mysql", providerCode: "1213" })
  })
  it("never reports a rollback when the callback did not complete", () => {
    const pg = classifyTransactionFailure({ code: "40001" }, "postgresql", false)
    expect(pg).not.toBeInstanceOf(TransactionRolledBackError)
    expect(pg).toBeInstanceOf(RetryablePersistenceError)
    expect(pg.message).toBe("Serialization failure detected — retry the operation")
    const my = classifyTransactionFailure({ code: "ER_LOCK_DEADLOCK" }, "mysql", false)
    expect(my).not.toBeInstanceOf(TransactionRolledBackError)
    expect(my.message).toBe("Persistence is temporarily unavailable")
  })
  it("does not treat other codes or other dialects' codes as definite rollbacks", () => {
    expect(classifyTransactionFailure({ code: "23505" }, "postgresql", true)).toBeInstanceOf(ConflictError)
    expect(classifyTransactionFailure({ code: "40002" }, "postgresql", true)).toBeInstanceOf(PersistenceError)
    expect(classifyTransactionFailure({ code: "ER_LOCK_DEADLOCK" }, "postgresql", true)).not.toBeInstanceOf(TransactionRolledBackError)
    expect(classifyTransactionFailure({ code: 1213 }, "postgresql", true)).not.toBeInstanceOf(TransactionRolledBackError)
    expect(classifyTransactionFailure({ code: "40001" }, "mysql", true)).not.toBeInstanceOf(TransactionRolledBackError)
    expect(classifyTransactionFailure({ code: "40P01" }, "mysql", true)).not.toBeInstanceOf(TransactionRolledBackError)
    expect(classifyTransactionFailure({ code: 1205 }, "mysql", true)).not.toBeInstanceOf(TransactionRolledBackError)
    expect(classifyTransactionFailure({ code: "ER_LOCK_WAIT_TIMEOUT" }, "mysql", true)).not.toBeInstanceOf(TransactionRolledBackError)
  })
  it("never reports a rollback for d1, whatever the code", () => {
    for (const code of ["40001", "40P01", "ER_LOCK_DEADLOCK", 1213, "SQLITE_BUSY", 5]) {
      const result = classifyTransactionFailure({ code }, "d1", true)
      expect(result).not.toBeInstanceOf(TransactionRolledBackError)
    }
    expect(classifyTransactionFailure({ code: "SQLITE_BUSY" }, "d1", true)).toBeInstanceOf(RetryablePersistenceError)
  })
  it("prefers the rollback classification over an already-classified framework error at commit", () => {
    const framework = new ConflictError("x")
    Object.defineProperty(framework, "code", { value: "40001" })
    const result = classifyTransactionFailure(framework, "postgresql", true)
    expect(result).toBeInstanceOf(TransactionRolledBackError)
    expect(result).not.toBe(framework)
  })
})

describe("classifyTransactionFailure: framework errors and timeouts", () => {
  it("returns an existing FrameworkCoreError unchanged, even if its code looks like a statement timeout", () => {
    const framework = new ConflictError("kept")
    Object.defineProperty(framework, "code", { value: "57014" })
    expect(classifyTransactionFailure(framework, "postgresql", false)).toBe(framework)
    expect(classifyTransactionFailure(framework, "postgresql", true)).toBe(framework)
    const mysql = new FrameworkCoreError("kept", "CONFLICT")
    Object.defineProperty(mysql, "code", { value: "ER_QUERY_TIMEOUT" })
    expect(classifyTransactionFailure(mysql, "mysql", false)).toBe(mysql)
  })
  it("maps PostgreSQL 57014 to the transaction TimeoutError, rolled_back only before commit", () => {
    const before = classifyTransactionFailure({ code: "57014" }, "postgresql", false)
    expect(before).toBeInstanceOf(TimeoutError)
    expect(before.message).toBe("The database transaction exceeded its deadline")
    expect(before.details).toStrictEqual({ dialect: "postgresql", providerCode: "57014", transactionOutcome: "rolled_back" })
    const after = classifyTransactionFailure({ code: "57014" }, "postgresql", true)
    expect(after).toBeInstanceOf(TimeoutError)
    expect(after.message).toBe("The database transaction exceeded its deadline")
    expect(after.details).toStrictEqual({ dialect: "postgresql", providerCode: "57014", transactionOutcome: "unknown" })
  })
  it("maps MySQL ER_QUERY_TIMEOUT and 3024 to the transaction TimeoutError", () => {
    const named = classifyTransactionFailure({ code: "ER_QUERY_TIMEOUT" }, "mysql", false)
    expect(named.message).toBe("The database transaction exceeded its deadline")
    expect(named.details).toStrictEqual({ dialect: "mysql", providerCode: "ER_QUERY_TIMEOUT", transactionOutcome: "rolled_back" })
    const numeric = classifyTransactionFailure({ errno: 3024 }, "mysql", true)
    expect(numeric).toBeInstanceOf(TimeoutError)
    expect(numeric.message).toBe("The database transaction exceeded its deadline")
    expect(numeric.details).toStrictEqual({ dialect: "mysql", providerCode: "3024", transactionOutcome: "unknown" })
  })
  it("does not treat other dialects' timeout codes as statement timeouts", () => {
    expect(classifyTransactionFailure({ code: "57014" }, "mysql", false)).toBeInstanceOf(PersistenceError)
    expect(classifyTransactionFailure({ code: "ER_QUERY_TIMEOUT" }, "postgresql", false)).toBeInstanceOf(PersistenceError)
    expect(classifyTransactionFailure({ code: 3024 }, "postgresql", false)).toBeInstanceOf(PersistenceError)
    expect(classifyTransactionFailure({ code: "57014" }, "d1", false)).toBeInstanceOf(PersistenceError)
    expect(classifyTransactionFailure({ code: "ER_QUERY_TIMEOUT" }, "d1", false)).toBeInstanceOf(PersistenceError)
    expect(classifyTransactionFailure({ code: 3024 }, "d1", false)).toBeInstanceOf(PersistenceError)
    for (const code of ["57014", "ER_QUERY_TIMEOUT", 3024]) {
      const result = classifyTransactionFailure({ code }, "d1", false)
      expect(result.message).toBe("Persistence operation failed")
      expect(result).not.toBeInstanceOf(TimeoutError)
    }
  })
  it("normalizes everything else without leaking provider text", () => {
    const result = classifyTransactionFailure(new Error("select secret from t"), "postgresql", false)
    expect(result).toBeInstanceOf(PersistenceError)
    expect(result.message).toBe("Persistence operation failed")
    expect(result.details).toStrictEqual({ dialect: "postgresql" })
  })
})

describe("machine code discovery", () => {
  it("falls back from code to errno and skips non-primitive codes", () => {
    expect(classifyTransactionFailure({ errno: 1213 }, "mysql", true)).toBeInstanceOf(TransactionRolledBackError)
    expect(classifyTransactionFailure({ code: undefined, errno: 1213 }, "mysql", true)).toBeInstanceOf(TransactionRolledBackError)
    const result = classifyTransactionFailure({ code: { nested: true }, cause: { code: "40001" } }, "postgresql", true)
    expect(result).toBeInstanceOf(TransactionRolledBackError)
    expect(result.details).toStrictEqual({ dialect: "postgresql", providerCode: "40001" })
    const skipsBoolean = classifyTransactionFailure({ code: true, cause: { code: 3024 } }, "mysql", false)
    expect(skipsBoolean.details).toStrictEqual({ dialect: "mysql", providerCode: "3024", transactionOutcome: "rolled_back" })
  })
  it("walks the cause chain up to six levels (depth 5 found, depth 6 not)", () => {
    const found = classifyTransactionFailure(chain(5, { code: "40001" }), "postgresql", true)
    expect(found).toBeInstanceOf(TransactionRolledBackError)
    const tooDeep = classifyTransactionFailure(chain(6, { code: "40001" }), "postgresql", true)
    expect(tooDeep).not.toBeInstanceOf(TransactionRolledBackError)
    expect(tooDeep.message).toBe("Persistence operation failed")
  })
  it("terminates on cyclic cause chains", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.cause = cyclic
    expect(classifyTransactionFailure(cyclic, "postgresql", true).message).toBe("Persistence operation failed")
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { cause: a }
    a.cause = b
    expect(classifyTransactionFailure(a, "mysql", true)).toBeInstanceOf(PersistenceError)
  })
  it("tolerates null, primitive and function errors and causes", () => {
    for (const bad of [null, undefined, 0, "", "boom", 42, true]) {
      const result = classifyTransactionFailure(bad as never, "postgresql", true)
      expect(result).toBeInstanceOf(PersistenceError)
      expect(result.details).toStrictEqual({ dialect: "postgresql" })
    }
    expect(classifyTransactionFailure({ cause: null }, "postgresql", true)).toBeInstanceOf(PersistenceError)
    expect(classifyTransactionFailure({ cause: "40001" }, "postgresql", true)).toBeInstanceOf(PersistenceError)
    const fn = Object.assign(() => undefined, { code: "40001" })
    expect(classifyTransactionFailure({ cause: fn }, "postgresql", true)).not.toBeInstanceOf(TransactionRolledBackError)
    expect(classifyTransactionFailure(fn as never, "postgresql", true)).not.toBeInstanceOf(TransactionRolledBackError)
  })
})

describe("transactionTimeoutError", () => {
  it("builds the exact message and details, omitting providerCode only when undefined", () => {
    const withCode = transactionTimeoutError("postgresql", "57014", true)
    expect(withCode).toBeInstanceOf(TimeoutError)
    expect(withCode.message).toBe("The database transaction exceeded its deadline")
    expect(withCode.details).toStrictEqual({ dialect: "postgresql", providerCode: "57014", transactionOutcome: "rolled_back" })
    const none = transactionTimeoutError("mysql", undefined, false)
    expect(none.details).toStrictEqual({ dialect: "mysql", transactionOutcome: "unknown" })
    expect(Object.hasOwn(none.details as object, "providerCode")).toBe(false)
    expect(transactionTimeoutError("mysql", 0, false).details).toStrictEqual({ dialect: "mysql", providerCode: "0", transactionOutcome: "unknown" })
    expect(transactionTimeoutError("d1", "", true).details).toStrictEqual({ dialect: "d1", providerCode: "", transactionOutcome: "rolled_back" })
  })
})

describe("statementTimeoutMs", () => {
  it("passes undefined through", () => {
    expect(statementTimeoutMs(undefined)).toBeUndefined()
  })
  it("clamps non-finite and sub-millisecond values to 1", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, -5, 0.5, 0.999]) expect(statementTimeoutMs(value)).toBe(1)
  })
  it("floors finite values and caps at the PostgreSQL limit", () => {
    expect(statementTimeoutMs(1)).toBe(1)
    expect(statementTimeoutMs(1.9)).toBe(1)
    expect(statementTimeoutMs(2)).toBe(2)
    expect(statementTimeoutMs(2.9)).toBe(2)
    expect(statementTimeoutMs(5000)).toBe(5000)
    expect(statementTimeoutMs(MAX_STATEMENT_TIMEOUT_MS)).toBe(2_147_483_647)
    expect(statementTimeoutMs(MAX_STATEMENT_TIMEOUT_MS + 1)).toBe(2_147_483_647)
    expect(statementTimeoutMs(1e15)).toBe(2_147_483_647)
    expect(MAX_STATEMENT_TIMEOUT_MS).toBe(2_147_483_647)
  })
})
