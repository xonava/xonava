import { BusinessRuleError, ConflictError, FrameworkCoreError, PersistenceError, RetryablePersistenceError, TimeoutError, ValidationError } from "core/domain"
export type DrizzleDialect="postgresql"|"d1"|"mysql"
const MAX_CAUSE_DEPTH=6
/** Yields the error and each object in its `cause` chain (bounded). */
function* causeChain(error:unknown):Generator<Record<string,unknown>>{let current=error;for(let depth=0;depth<MAX_CAUSE_DEPTH&&current&&typeof current==="object";depth++){yield current as Record<string,unknown>;current=(current as Record<string,unknown>).cause}}
function machineCode(error:unknown):string|number|undefined{for(const current of causeChain(error)){const code=current.code??current.errno;if(typeof code==="string"||typeof code==="number")return code}return undefined}
/** Provider messages along the cause chain. Used only for classification, never copied into framework errors. */
function providerMessages(error:unknown):string[]{const messages:string[]=[];for(const current of causeChain(error))if(typeof current.message==="string")messages.push(current.message);return messages}
type D1MessageClass="conflict"|"foreign_key"|"not_null"|"check"|"retryable"
/** D1 surfaces SQLite failures without machine codes, so classification falls back to stable SQLite message markers. */
function classifyD1Message(error:unknown):D1MessageClass|undefined{
  for(const message of providerMessages(error)){
    if(message.includes("UNIQUE constraint failed"))return "conflict"
    if(message.includes("FOREIGN KEY constraint failed"))return "foreign_key"
    if(message.includes("NOT NULL constraint failed"))return "not_null"
    if(message.includes("CHECK constraint failed"))return "check"
    if(message.includes("SQLITE_BUSY")||message.includes("database is locked")||message.includes("Overloaded")||message.includes("Network connection lost")||/D1_ERROR\b.*\breset\b/i.test(message))return "retryable"
  }
  return undefined
}
/** Converts provider failures using machine codes (and, for D1, stable SQLite markers); SQL text and provider messages are never copied. */
export function normalizeDrizzleError(error:unknown,dialect:DrizzleDialect):FrameworkCoreError{
  if(error instanceof FrameworkCoreError)return error
  const code=machineCode(error);const details=code===undefined?{dialect}:{dialect,providerCode:String(code)}
  if(dialect==="postgresql"){
    if(code==="23505")return new ConflictError("A record with this value already exists",details)
    if(code==="23503")return new BusinessRuleError("Referenced record not found",details)
    if(code==="23502")return new ValidationError("A required field is missing",details)
    if(code==="23514")return new BusinessRuleError("A validation check failed",details)
    if(code==="40001")return new RetryablePersistenceError("Serialization failure detected — retry the operation",{postgresCode:code})
    if(code==="40P01")return new RetryablePersistenceError("Deadlock detected — retry the operation",{postgresCode:code})
    if(code==="57014")return new TimeoutError("The database statement exceeded its deadline",details)
    if(code==="55P03")return new TimeoutError("The database could not acquire a lock in time",details)
  }else if(dialect==="d1"){
    if(code==="SQLITE_CONSTRAINT_UNIQUE"||code===2067)return new ConflictError("A record with this value already exists",details)
    if(code==="SQLITE_CONSTRAINT_FOREIGNKEY"||code===787)return new BusinessRuleError("Referenced record not found",details)
    if(code==="SQLITE_CONSTRAINT_NOTNULL"||code===1299)return new ValidationError("A required field is missing",details)
    if(code==="SQLITE_CONSTRAINT_CHECK"||code===275)return new BusinessRuleError("A validation check failed",details)
    if(code==="SQLITE_BUSY"||code==="SQLITE_LOCKED"||code===5||code===6)return new RetryablePersistenceError("Persistence is temporarily unavailable",details)
    switch(classifyD1Message(error)){
      case "conflict":return new ConflictError("A record with this value already exists",details)
      case "foreign_key":return new BusinessRuleError("Referenced record not found",details)
      case "not_null":return new ValidationError("A required field is missing",details)
      case "check":return new BusinessRuleError("A validation check failed",details)
      case "retryable":return new RetryablePersistenceError("Persistence is temporarily unavailable",details)
      default:break
    }
  }else{
    if(code==="ER_DUP_ENTRY"||code===1062)return new ConflictError("A record with this value already exists",details)
    if(code==="ER_NO_REFERENCED_ROW_2"||code===1452)return new BusinessRuleError("Referenced record not found",details)
    if(code==="ER_BAD_NULL_ERROR"||code===1048)return new ValidationError("A required field is missing",details)
    if(code==="ER_CHECK_CONSTRAINT_VIOLATED"||code===3819)return new BusinessRuleError("A validation check failed",details)
    if(code==="ER_LOCK_DEADLOCK"||code===1213||code==="ER_LOCK_WAIT_TIMEOUT"||code===1205)return new RetryablePersistenceError("Persistence is temporarily unavailable",details)
    if(code==="ER_QUERY_TIMEOUT"||code===3024)return new TimeoutError("The database statement exceeded its deadline",details)
  }
  return new PersistenceError("Persistence operation failed",details)
}
export function rethrowNormalizedDrizzleError(error:unknown,dialect:DrizzleDialect):never{throw normalizeDrizzleError(error,dialect)}
/** True when the failure (or any wrapped cause, e.g. a DrizzleQueryError) is a unique-constraint violation. */
export function isUniqueViolation(error:unknown,dialect:DrizzleDialect):boolean{
  if(error instanceof ConflictError)return true
  if(error instanceof FrameworkCoreError)return false
  for(const current of causeChain(error)){
    const code=current.code??current.errno
    if(dialect==="postgresql"&&code==="23505")return true
    if(dialect==="mysql"&&(code==="ER_DUP_ENTRY"||code===1062))return true
    if(dialect==="d1"&&(code==="SQLITE_CONSTRAINT_UNIQUE"||code===2067||code==="SQLITE_CONSTRAINT_PRIMARYKEY"||code===1555))return true
  }
  return dialect==="d1"&&classifyD1Message(error)==="conflict"
}
/** Name of the violated constraint reported by the driver (PostgreSQL `constraint`), searched along the cause chain. */
export function violatedConstraintName(error:unknown):string|undefined{for(const current of causeChain(error))if(typeof current.constraint==="string"&&current.constraint.length>0)return current.constraint;return undefined}
