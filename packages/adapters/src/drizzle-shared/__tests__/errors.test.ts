import { describe,expect,it } from "vitest"
import { normalizeDrizzleError } from "../errors"
import { ConflictError,FrameworkCoreError,PersistenceError,RetryablePersistenceError } from "core/domain"

describe("ER1 Drizzle error normalization",()=>{
  it("maps PostgreSQL and D1 machine codes",()=>{expect(normalizeDrizzleError(Object.assign(new Error("secret SQL"),{code:"23505"}),"postgresql")).toBeInstanceOf(ConflictError);expect(normalizeDrizzleError(Object.assign(new Error("secret SQL"),{code:"SQLITE_BUSY"}),"d1")).toBeInstanceOf(RetryablePersistenceError)})
  it("maps MySQL machine codes without copying messages",()=>{expect(normalizeDrizzleError(Object.assign(new Error("secret table"),{code:"ER_DUP_ENTRY",errno:1062}),"mysql")).toBeInstanceOf(ConflictError);expect(normalizeDrizzleError({errno:1213,message:"deadlock SQL"},"mysql")).toBeInstanceOf(RetryablePersistenceError)})
  it("walks wrapped causes and preserves framework errors",()=>{const original=new ConflictError();expect(normalizeDrizzleError({cause:{cause:{code:2067,message:"table secret"}}},"d1")).toBeInstanceOf(ConflictError);expect(normalizeDrizzleError(original,"postgresql")).toBe(original)})
  it("normalizes unknown failures without copying provider messages",()=>{const normalized=normalizeDrizzleError(new Error("SELECT password FROM secrets"),"postgresql");expect(normalized).toBeInstanceOf(PersistenceError);expect(normalized).toBeInstanceOf(FrameworkCoreError);expect(normalized.message).not.toContain("password");expect(normalized.safeMessage).toBe("Internal Server Error")})
})
