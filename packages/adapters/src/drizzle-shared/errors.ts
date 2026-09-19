import { BusinessRuleError, ConflictError, FrameworkCoreError, PersistenceError, RetryablePersistenceError, ValidationError } from "core/domain"
export type DrizzleDialect="postgresql"|"d1"|"mysql"
function machineCode(error:unknown):string|number|undefined{let current=error;for(let depth=0;depth<6&&current&&typeof current==="object";depth++){const code=(current as Record<string,unknown>).code??(current as Record<string,unknown>).errno;if(typeof code==="string"||typeof code==="number")return code;current=(current as Record<string,unknown>).cause}return undefined}
/** Converts provider failures using machine codes only; SQL text and provider messages are never copied. */
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
  }else if(dialect==="d1"){
    if(code==="SQLITE_CONSTRAINT_UNIQUE"||code===2067)return new ConflictError("A record with this value already exists",details)
    if(code==="SQLITE_CONSTRAINT_FOREIGNKEY"||code===787)return new BusinessRuleError("Referenced record not found",details)
    if(code==="SQLITE_CONSTRAINT_NOTNULL"||code===1299)return new ValidationError("A required field is missing",details)
    if(code==="SQLITE_CONSTRAINT_CHECK"||code===275)return new BusinessRuleError("A validation check failed",details)
    if(code==="SQLITE_BUSY"||code==="SQLITE_LOCKED"||code===5||code===6)return new RetryablePersistenceError("Persistence is temporarily unavailable",details)
  }else{
    if(code==="ER_DUP_ENTRY"||code===1062)return new ConflictError("A record with this value already exists",details)
    if(code==="ER_NO_REFERENCED_ROW_2"||code===1452)return new BusinessRuleError("Referenced record not found",details)
    if(code==="ER_BAD_NULL_ERROR"||code===1048)return new ValidationError("A required field is missing",details)
    if(code==="ER_CHECK_CONSTRAINT_VIOLATED"||code===3819)return new BusinessRuleError("A validation check failed",details)
    if(code==="ER_LOCK_DEADLOCK"||code===1213||code==="ER_LOCK_WAIT_TIMEOUT"||code===1205)return new RetryablePersistenceError("Persistence is temporarily unavailable",details)
  }
  return new PersistenceError("Persistence operation failed",details)
}
export function rethrowNormalizedDrizzleError(error:unknown,dialect:DrizzleDialect):never{throw normalizeDrizzleError(error,dialect)}
