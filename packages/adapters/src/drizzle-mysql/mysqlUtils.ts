import {ConfigurationError} from "@xonava/core/domain"
export function getMySqlAffectedRows(result:unknown):number{const value=Array.isArray(result)?result[0]:result;if(!value||typeof value!=="object")return 0;const record=value as Record<string,unknown>;return typeof record.affectedRows==="number"?record.affectedRows:typeof record.rowsAffected==="number"?record.rowsAffected:0}

/** Largest MySQL transaction timeout accepted, in milliseconds (INT_MAX, as for PostgreSQL). */
export const MAX_MYSQL_TRANSACTION_TIMEOUT_MS=2_147_483_647
/** TransactionOptions.timeoutMs must be a positive safe integer no larger than INT_MAX milliseconds. */
export function validateMySqlTransactionTimeout(timeoutMs:unknown):number|undefined{
  if(timeoutMs===undefined)return undefined
  if(typeof timeoutMs!=="number"||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_MYSQL_TRANSACTION_TIMEOUT_MS)throw new ConfigurationError(`MySQL transaction timeoutMs must be an integer from 1 to ${MAX_MYSQL_TRANSACTION_TIMEOUT_MS}`)
  return timeoutMs
}
/**
 * Validates a unique-index → field map: a plain object whose own enumerable keys and values are
 * non-empty strings. Returns a frozen null-prototype copy so later mutation cannot change classification.
 */
export function validateMySqlConstraintMap(constraintMap:unknown):Readonly<Record<string,string>>|undefined{
  if(constraintMap===undefined)return undefined
  if(constraintMap===null||typeof constraintMap!=="object"||Array.isArray(constraintMap))throw new ConfigurationError("MySQL constraintMap must be an object mapping unique index names to field names")
  const copy:Record<string,string>=Object.create(null) as Record<string,string>
  for(const key of Reflect.ownKeys(constraintMap)){
    if(typeof key!=="string"||key.trim()==="")throw new ConfigurationError("MySQL constraintMap keys must be non-empty index names")
    const descriptor=Object.getOwnPropertyDescriptor(constraintMap,key)
    if(!descriptor||!("value" in descriptor)||!descriptor.enumerable)throw new ConfigurationError(`MySQL constraintMap entry "${key}" must be a plain own property`)
    const value:unknown=descriptor.value
    if(typeof value!=="string"||value.trim()==="")throw new ConfigurationError(`MySQL constraintMap entry "${key}" must map to a non-empty field name`)
    copy[key]=value
  }
  return Object.freeze(copy)
}
