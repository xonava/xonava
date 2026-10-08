import { describe,expect,it } from "vitest"
import { isUniqueViolation, normalizeDrizzleError } from "../errors"
import { BusinessRuleError,ConflictError,FrameworkCoreError,PersistenceError,RetryablePersistenceError,TimeoutError,ValidationError } from "core/domain"

describe("ER1 Drizzle error normalization",()=>{
  it("maps PostgreSQL and D1 machine codes",()=>{expect(normalizeDrizzleError(Object.assign(new Error("secret SQL"),{code:"23505"}),"postgresql")).toBeInstanceOf(ConflictError);expect(normalizeDrizzleError(Object.assign(new Error("secret SQL"),{code:"SQLITE_BUSY"}),"d1")).toBeInstanceOf(RetryablePersistenceError)})
  it("maps MySQL machine codes without copying messages",()=>{expect(normalizeDrizzleError(Object.assign(new Error("secret table"),{code:"ER_DUP_ENTRY",errno:1062}),"mysql")).toBeInstanceOf(ConflictError);expect(normalizeDrizzleError({errno:1213,message:"deadlock SQL"},"mysql")).toBeInstanceOf(RetryablePersistenceError)})
  it("walks wrapped causes and preserves framework errors",()=>{const original=new ConflictError();expect(normalizeDrizzleError({cause:{cause:{code:2067,message:"table secret"}}},"d1")).toBeInstanceOf(ConflictError);expect(normalizeDrizzleError(original,"postgresql")).toBe(original)})
  it("normalizes unknown failures without copying provider messages",()=>{const normalized=normalizeDrizzleError(new Error("SELECT password FROM secrets"),"postgresql");expect(normalized).toBeInstanceOf(PersistenceError);expect(normalized).toBeInstanceOf(FrameworkCoreError);expect(normalized.message).not.toContain("password");expect(normalized.safeMessage).toBe("Internal Server Error")})
})

describe("timeout and D1 message classification",()=>{
  it("maps statement timeouts and lock-not-available to TimeoutError",()=>{
    for(const [code,dialect] of [["57014","postgresql"],["55P03","postgresql"],[3024,"mysql"],["ER_QUERY_TIMEOUT","mysql"]] as const){const normalized=normalizeDrizzleError({cause:Object.assign(new Error("canceling statement due to statement timeout: SELECT secret"),{code})},dialect);expect(normalized).toBeInstanceOf(TimeoutError);expect(normalized.message).not.toContain("secret")}
    expect(normalizeDrizzleError({errno:1205},"mysql")).toBeInstanceOf(RetryablePersistenceError)
  })
  it("classifies code-less D1 failures by SQLite markers along the cause chain without copying messages",()=>{
    const wrapped=(message:string)=>({message:"Failed query: insert into secret_table",cause:new Error(message)})
    const cases:[string,unknown][]=[["D1_ERROR: UNIQUE constraint failed: secret_table.email: SQLITE_CONSTRAINT",ConflictError],["FOREIGN KEY constraint failed: SQLITE_CONSTRAINT",BusinessRuleError],["NOT NULL constraint failed: secret_table.name",ValidationError],["CHECK constraint failed: positive_amount",BusinessRuleError],["D1_ERROR: database is locked",RetryablePersistenceError],["SQLITE_BUSY",RetryablePersistenceError],["D1_ERROR: Overloaded",RetryablePersistenceError],["Network connection lost.",RetryablePersistenceError],["D1_ERROR: Internal error, the database was reset",RetryablePersistenceError]]
    for(const [message,type] of cases){const normalized=normalizeDrizzleError(wrapped(message),"d1");expect(normalized).toBeInstanceOf(type as never);expect(normalized.message).not.toMatch(/secret|constraint failed|D1_ERROR/);expect(JSON.stringify(normalized.details)).not.toMatch(/secret/)}
    expect(normalizeDrizzleError(new Error("D1_ERROR: no such table: secret"),"d1")).toBeInstanceOf(PersistenceError)
  })
  it("isUniqueViolation walks wrapped causes for every dialect",()=>{
    expect(isUniqueViolation({message:"Failed query",cause:{code:"23505"}},"postgresql")).toBe(true)
    expect(isUniqueViolation({cause:{errno:1062}},"mysql")).toBe(true)
    expect(isUniqueViolation({cause:new Error("UNIQUE constraint failed: jobs.idempotency_key")},"d1")).toBe(true)
    expect(isUniqueViolation({cause:{code:"23503"}},"postgresql")).toBe(false)
    expect(isUniqueViolation(new Error("unique-looking text"),"postgresql")).toBe(false)
    expect(isUniqueViolation(new ConflictError(),"postgresql")).toBe(true)
  })
})
