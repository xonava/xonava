import { describe,expect,it } from "vitest"
import { expectNearLinear } from "../../../../core/src/__tests__/timing"
import { isUniqueViolation, normalizeDrizzleError } from "../errors"
import { BusinessRuleError,ConflictError,FrameworkCoreError,PersistenceError,RetryablePersistenceError,TimeoutError,ValidationError } from "@xonava/core/domain"

describe("ER1 Drizzle error normalization",()=>{
  it("maps PostgreSQL and D1 machine codes",()=>{expect(normalizeDrizzleError(Object.assign(new Error("secret SQL"),{code:"23505"}),"postgresql")).toBeInstanceOf(ConflictError);expect(normalizeDrizzleError(Object.assign(new Error("secret SQL"),{code:"SQLITE_BUSY"}),"d1")).toBeInstanceOf(RetryablePersistenceError)})
  it("maps MySQL machine codes without copying messages",()=>{expect(normalizeDrizzleError(Object.assign(new Error("secret table"),{code:"ER_DUP_ENTRY",errno:1062}),"mysql")).toBeInstanceOf(ConflictError);expect(normalizeDrizzleError({errno:1213,message:"deadlock SQL"},"mysql")).toBeInstanceOf(RetryablePersistenceError)})
  it("walks wrapped causes and preserves framework errors",()=>{const original=new ConflictError();expect(normalizeDrizzleError({cause:{cause:{code:2067,message:"table secret"}}},"d1")).toBeInstanceOf(ConflictError);expect(normalizeDrizzleError(original,"postgresql")).toBe(original)})
  it("normalizes unknown failures without copying provider messages",()=>{const normalized=normalizeDrizzleError(new Error("SELECT password FROM secrets"),"postgresql");expect(normalized).toBeInstanceOf(PersistenceError);expect(normalized).toBeInstanceOf(FrameworkCoreError);expect(normalized.message).not.toContain("password");expect(normalized.safeMessage).toBe("Internal Server Error")})
})

describe("timeout and D1 message classification",()=>{
  const classify=(message:string)=>normalizeDrizzleError(new Error(message),"d1")
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
  it("classifies D1 reset errors in linear time on repeated D1_ERROR tokens",async()=>{
    for(const suffix of ["","reset"]){
      const message=(size:number)=>"D1_ERROR ".repeat(Math.floor(size/9))+suffix
      expect(classify(message(198_000))).toBeInstanceOf(suffix==="reset"?RetryablePersistenceError:PersistenceError)
      await expectNearLinear((size)=>{const text=message(size);return()=>classify(text)},{size:198_000})
    }
  })
  it("matches the original D1_ERROR...reset regex on fragment strings",()=>{
    const oracle=/D1_ERROR\b.*\breset\b/i
    const fragments=["D1_ERROR","d1_error","D1_ERRORS","D1_ERROR_X"," ",": ","\n","\r","\u2028","\u2029","reset","RESET","Reset","resets","_reset","xreset","reset_","re set","-","é","ſ","Internal error, the database was reset"]
    let state=0x9e3779b9
    const next=(bound:number)=>{state=Math.imul(state^(state>>>15),0x2c1b3c6d)>>>0;state=(state+0x7f4a7c15)>>>0;return state%bound}
    let retryable=0
    for(let index=0;index<3000;index++){
      let message="";for(let length=next(10);length>=0;length--)message+=fragments[next(fragments.length)]
      const expected=oracle.test(message);if(expected)retryable++
      expect(classify(message)).toBeInstanceOf(expected?RetryablePersistenceError:PersistenceError)
    }
    expect(retryable).toBeGreaterThan(10)
    expect(retryable).toBeLessThan(2990)
    for(const [message,expected] of [["reset D1_ERROR",false],["D1_ERROR\nreset",false],["D1_ERROR \u2028 reset",false],["D1_ERRORreset",false],["D1_ERROR reset",true],["x D1_ERRORS D1_ERROR: reset",true],["D1_ERROR; was reset.",true]] as const)expect(classify(message)).toBeInstanceOf(expected?RetryablePersistenceError:PersistenceError)
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
