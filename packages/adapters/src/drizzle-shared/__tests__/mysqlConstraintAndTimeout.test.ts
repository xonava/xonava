import { describe, expect, it } from "vitest"
import { ConflictError, RetryablePersistenceError, TimeoutError, TransactionRolledBackError } from "core/domain"
import { hasMySqlErrorCode, mysqlConstraintField, mysqlDuplicateKeyName, normalizeDrizzleError } from "../errors"
import { classifyTransactionFailure, transactionTimeoutError } from "../transactionOutcome"

const duplicate = (sqlMessage: string, extra: Record<string, unknown> = {}) => ({ message: "Failed query: insert into users ... params: secret", cause: Object.assign(new Error(sqlMessage), { code: "ER_DUP_ENTRY", errno: 1062, sqlMessage, ...extra }) })

describe("MySQL duplicate-key index extraction", () => {
  it("reads table.index (8.0.19+) and bare index forms from sqlMessage along the cause chain", () => {
    expect(mysqlDuplicateKeyName(duplicate("Duplicate entry 'a@b.c' for key 'users.users_email_uq'"))).toBe("users.users_email_uq")
    expect(mysqlDuplicateKeyName(duplicate("Duplicate entry 'a@b.c' for key 'users_email_uq'"))).toBe("users_email_uq")
    expect(mysqlDuplicateKeyName(duplicate("Duplicate entry 'x-1' for key 'PRIMARY'"))).toBe("PRIMARY")
  })
  it("cannot be spoofed by the duplicated value and rejects non-identifiers", () => {
    expect(mysqlDuplicateKeyName(duplicate("Duplicate entry 'x' for key 'users_email_uq' for key 'users.users_handle_uq'"))).toBe("users.users_handle_uq")
    expect(mysqlDuplicateKeyName(duplicate("Duplicate entry 'x' for key 'users.bad name'"))).toBeUndefined()
    expect(mysqlDuplicateKeyName(duplicate("Duplicate entry 'x' for key 'a.b.c'"))).toBeUndefined()
    expect(mysqlDuplicateKeyName(duplicate("something else"))).toBeUndefined()
    // Only the duplicate-key error's own sqlMessage is consulted.
    expect(mysqlDuplicateKeyName({ cause: Object.assign(new Error("x"), { code: "ER_BAD_NULL_ERROR", sqlMessage: "Duplicate entry 'x' for key 'users_email_uq'" }) })).toBeUndefined()
    expect(mysqlDuplicateKeyName(new Error("Duplicate entry 'x' for key 'users_email_uq'"))).toBeUndefined()
  })
  it("maps both forms through constraintMap own properties only", () => {
    const map = { users_email_uq: "email", "users.users_handle_uq": "handle" }
    expect(mysqlConstraintField(duplicate("Duplicate entry 'x' for key 'users.users_email_uq'"), map)).toBe("email")
    expect(mysqlConstraintField(duplicate("Duplicate entry 'x' for key 'users_email_uq'"), map)).toBe("email")
    expect(mysqlConstraintField(duplicate("Duplicate entry 'x' for key 'users.users_handle_uq'"), map)).toBe("handle")
    expect(mysqlConstraintField(duplicate("Duplicate entry 'x' for key 'users_handle_uq'"), map)).toBeUndefined()
    expect(mysqlConstraintField(duplicate("Duplicate entry 'x' for key 'toString'"), map)).toBeUndefined()
    const normalized = normalizeDrizzleError(duplicate("Duplicate entry 'a@b.c' for key 'users.users_email_uq'"), "mysql")
    expect(normalized).toBeInstanceOf(ConflictError)
    expect(`${normalized.message} ${JSON.stringify(normalized.details)}`).not.toMatch(/a@b\.c|users_email_uq|secret/)
  })
})

describe("MySQL timeout classification", () => {
  it("recognizes codes on raw and normalized errors", () => {
    expect(hasMySqlErrorCode({ cause: { errno: 1317 } }, "ER_QUERY_INTERRUPTED")).toBe(true)
    expect(hasMySqlErrorCode(normalizeDrizzleError({ code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205 }, "mysql"), "ER_LOCK_WAIT_TIMEOUT")).toBe(true)
    expect(hasMySqlErrorCode(normalizeDrizzleError({ code: "ER_LOCK_DEADLOCK", errno: 1213 }, "mysql"), "ER_LOCK_WAIT_TIMEOUT")).toBe(false)
    expect(hasMySqlErrorCode(new RetryablePersistenceError("x", { dialect: "postgresql", providerCode: "1205" }), "ER_LOCK_WAIT_TIMEOUT")).toBe(false)
    expect(normalizeDrizzleError({ errno: 1205 }, "mysql")).toBeInstanceOf(RetryablePersistenceError)
  })
  it("reports a timeout before COMMIT as rolled back and a timeout after the callback as unknown", () => {
    const before = classifyTransactionFailure({ code: "ER_QUERY_TIMEOUT", errno: 3024 }, "mysql", false)
    expect(before).toBeInstanceOf(TimeoutError)
    expect(before.details).toMatchObject({ transactionOutcome: "rolled_back" })
    const after = classifyTransactionFailure({ code: "ER_QUERY_TIMEOUT", errno: 3024 }, "mysql", true)
    expect(after).toBeInstanceOf(TimeoutError)
    expect(after).not.toBeInstanceOf(RetryablePersistenceError)
    expect(after.details).toMatchObject({ transactionOutcome: "unknown" })
    expect(classifyTransactionFailure({ errno: 1213 }, "mysql", true)).toBeInstanceOf(TransactionRolledBackError)
    expect(transactionTimeoutError("mysql", undefined, true)).not.toBeInstanceOf(RetryablePersistenceError)
  })
})
