import {classifyTransactionFailure,transactionTimeoutError} from "../drizzle-shared/transactionOutcome"
import {hasMySqlErrorCode,normalizeDrizzleError} from "../drizzle-shared/errors"
import {sql} from "drizzle-orm"
import type {AnyMySqlTable} from "drizzle-orm/mysql-core"
import {ConfigurationError,PersistenceError} from "core/domain"
import type { EntityDescriptor, InteractiveTransactionProvider, PersistenceProvider, TransactionOptions, UnversionedEntityDescriptor, UnversionedRepository, VersionedEntityDescriptor, VersionedRepository } from "core/persistence"
import type { PersistenceCapabilities } from "core/persistence"
import {createDrizzleMySqlRepository,type MySqlDatabaseLike} from "./drizzleRepository"
import type {DrizzleColumnMap} from "../drizzle-shared/predicateCompiler"
import {validateMySqlConstraintMap,validateMySqlTransactionTimeout} from "./mysqlUtils"

const sessionByProvider=new WeakMap<PersistenceProvider,MySqlDatabaseLike>()
export function getDrizzleMySqlSession(provider:PersistenceProvider):MySqlDatabaseLike{const session=sessionByProvider.get(provider);if(!session)throw new ConfigurationError("No Drizzle MySQL session found for this persistence provider");return session}

export interface MySqlEntityMapping{readonly table:AnyMySqlTable;readonly columnMap:DrizzleColumnMap}
export class DrizzleMySqlEntityRegistry{private readonly mappings=new Map<string,MySqlEntityMapping>();register<T>(entity:EntityDescriptor<T>,table:AnyMySqlTable,columnMap:DrizzleColumnMap,namespace?:string):this{const key=namespace?`${namespace}:${entity?.name}`:String(entity?.name);validateMySqlEntityRegistration(entity,columnMap,key);if(this.mappings.has(key))throw new ConfigurationError(`Invalid or duplicate MySQL entity registration: ${key}`);this.mappings.set(key,{table,columnMap});return this}get(name:string,namespace?:string){return this.mappings.get(namespace?`${namespace}:${name}`:name)}}
/** Mirrors the PostgreSQL registry: primary key and version field must be declared, mapped fields. */
function validateMySqlEntityRegistration<T>(entity:EntityDescriptor<T>,columnMap:DrizzleColumnMap,key:string):void{
  if(!entity||typeof entity.name!=="string"||!entity.name.trim())throw new ConfigurationError(`MySQL registry registration "${key}" requires a non-empty entity name`)
  if(!entity.fields||typeof entity.fields!=="object"||Object.keys(entity.fields).length===0)throw new ConfigurationError(`Entity "${key}" must declare fields before registration`)
  if(Object.keys(columnMap).some(mapKey=>mapKey===""))throw new ConfigurationError(`Entity "${key}" declares an empty column map key`)
  const declared=Object.keys(entity.fields);const missing=declared.filter(field=>!Object.prototype.hasOwnProperty.call(columnMap,field)||!columnMap[field])
  if(missing.length>0)throw new ConfigurationError(`Entity "${key}" column map is missing fields: ${missing.join(", ")}`)
  const primaryKey=String(entity.primaryKey??"id");if(!declared.includes(primaryKey))throw new ConfigurationError(`Entity "${key}" primary key "${primaryKey}" is not a declared field`)
  if(entity.versionField!==undefined&&!declared.includes(String(entity.versionField)))throw new ConfigurationError(`Entity "${key}" version field "${String(entity.versionField)}" is not a declared field`)
}
function validateMySqlMaxPageSize(value:number|undefined):number|undefined{if(value!==undefined&&(!Number.isFinite(value)||!Number.isInteger(value)||value<=0))throw new ConfigurationError("MySQL maxPageSize must be a finite positive integer");return value}

interface MySqlKillConnection{readonly threadId?:number|null;query(statement:string):Promise<unknown>;release():void}
interface MySqlKillPool{getConnection():Promise<MySqlKillConnection>}
/** The pool behind a Drizzle mysql2 database, used to send KILL QUERY from a separate connection. */
function resolveKillPool(db:MySqlDatabaseLike):MySqlKillPool|undefined{
  const client=(db as {$client?:unknown}).$client
  if(!client||typeof client!=="object")return undefined
  // Mirrors drizzle-orm/mysql2: a callback-style client is used through its promise wrapper.
  const promiseClient:unknown=typeof (client as {promise?:unknown}).promise==="function"?(client as {promise():unknown}).promise():client
  if(!promiseClient||typeof promiseClient!=="object"||typeof (promiseClient as {getConnection?:unknown}).getConnection!=="function")return undefined
  return promiseClient as MySqlKillPool
}
function resultRows(result:unknown):Record<string,unknown>[]{const rows=Array.isArray(result)&&Array.isArray(result[0])?result[0]:result;return Array.isArray(rows)?rows as Record<string,unknown>[]:[]}
function sessionInteger(value:unknown,name:string):number{const parsed=typeof value==="bigint"?Number(value):typeof value==="string"?Number(value):value;if(typeof parsed!=="number"||!Number.isSafeInteger(parsed)||parsed<0)throw new PersistenceError("Could not read MySQL session limits",{dialect:"mysql",variable:name});return parsed}

/**
 * Enforces TransactionOptions.timeoutMs for one transaction on its dedicated connection.
 *
 * MySQL has no transaction-scoped statement timeout for DML, so the bound is layered:
 * - `max_execution_time` (SELECT only) and `innodb_lock_wait_timeout` (row-lock waits) are lowered
 *   to the remaining budget for the session, and restored before the connection returns to the pool;
 * - a watchdog timer fires at the deadline, marks the transaction timed out (it can then never
 *   commit) and sends `KILL QUERY <id>` from a separate pool connection so an in-flight statement
 *   fails with ER_QUERY_INTERRUPTED. The connection itself is never killed.
 * The watchdog is disarmed before COMMIT is sent, and any KILL already sent is awaited before the
 * session is restored, so a KILL can never reach COMMIT, the restore, or a later reuse of the connection.
 * KILL QUERY needs the same MySQL user as the transaction connection, or CONNECTION_ADMIN.
 */
const KILL_REPEAT_MS=250
const TIMEOUT_CODES=["ER_QUERY_INTERRUPTED","ER_QUERY_TIMEOUT","ER_LOCK_WAIT_TIMEOUT"] as const
class MySqlTransactionDeadline{
  private connectionId:number|undefined
  private previous:{maxExecutionTime:number;lockWaitTimeout:number}|undefined
  private modified=false
  private finished=false
  private timer:ReturnType<typeof setTimeout>|undefined
  private killInFlight:Promise<void>|undefined
  fired=false
  shortenedLockWait=false
  constructor(private readonly tx:MySqlDatabaseLike,private readonly killPool:MySqlKillPool|undefined,private readonly deadlineAt:number){}
  private async execute(statement:string):Promise<unknown>{return await this.tx.execute(sql.raw(statement))}
  async arm():Promise<void>{
    if(this.deadlineAt-Date.now()<=0)throw transactionTimeoutError("mysql",undefined,true)
    const row=resultRows(await this.execute("SELECT CONNECTION_ID() AS connectionId, @@session.max_execution_time AS maxExecutionTime, @@session.innodb_lock_wait_timeout AS lockWaitTimeout"))[0]??{}
    const connectionId=sessionInteger(row.connectionId,"connection_id");if(connectionId<1)throw new PersistenceError("Could not read MySQL session limits",{dialect:"mysql",variable:"connection_id"})
    const previous={maxExecutionTime:sessionInteger(row.maxExecutionTime,"max_execution_time"),lockWaitTimeout:sessionInteger(row.lockWaitTimeout,"innodb_lock_wait_timeout")}
    this.connectionId=connectionId;this.previous=previous
    const remaining=this.deadlineAt-Date.now()
    if(remaining<=0)throw transactionTimeoutError("mysql",undefined,true)
    // Never lengthen a stricter limit already configured for the session.
    const maxExecutionTime=previous.maxExecutionTime>0?Math.min(previous.maxExecutionTime,remaining):remaining
    const budgetSeconds=Math.max(1,Math.ceil(remaining/1000))
    const lockWaitTimeout=previous.lockWaitTimeout>0?Math.min(previous.lockWaitTimeout,budgetSeconds):budgetSeconds
    this.shortenedLockWait=lockWaitTimeout<previous.lockWaitTimeout
    this.modified=true
    // SET cannot take bind parameters; both values are validated integers.
    await this.execute(`SET SESSION max_execution_time = ${maxExecutionTime}, innodb_lock_wait_timeout = ${lockWaitTimeout}`)
    if(this.finished)return
    this.timer=setTimeout(()=>this.fire(),Math.max(0,this.deadlineAt-Date.now()))
  }
  private fire():void{
    this.timer=undefined
    if(this.finished)return
    this.fired=true
    this.sendKill()
  }
  /**
   * Sends KILL QUERY from a separate pool connection. A KILL that reaches the connection between two
   * statements has no effect, so it is repeated while the transaction is still running.
   */
  private sendKill():void{
    const killPool=this.killPool;const targetId=this.connectionId
    if(this.finished||!killPool||targetId===undefined)return
    // Acquiring the kill connection is not awaited by release(): a saturated pool can never deadlock
    // with this transaction's own connection, and a late connection simply finds the work finished.
    void killPool.getConnection().then(connection=>{
      if(this.finished||connection.threadId===targetId){connection.release();return}
      const kill=connection.query(`KILL QUERY ${targetId}`).then(()=>true,()=>false).finally(()=>connection.release())
      const previous=this.killInFlight
      this.killInFlight=Promise.all([previous,kill]).then(()=>undefined)
      void kill.then(sent=>{if(sent&&!this.finished)this.timer=setTimeout(()=>{this.timer=undefined;this.sendKill()},KILL_REPEAT_MS)})
    },()=>undefined)
  }
  /** Stops the watchdog; after this no KILL is sent. Call before COMMIT. */
  disarm():void{this.finished=true;if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined}}
  /**
   * Disarms, waits for a KILL already sent, then restores the session variables before the connection
   * returns to the pool. On the failure path a restore error is suppressed so the original error wins.
   */
  async release(failed:boolean):Promise<void>{
    this.disarm()
    if(this.killInFlight)await this.killInFlight
    if(!this.modified||!this.previous)return
    const restore=`SET SESSION max_execution_time = ${this.previous.maxExecutionTime}, innodb_lock_wait_timeout = ${this.previous.lockWaitTimeout}`
    try{await this.execute(restore)}catch(error){
      // A KILL that raced with statement completion can only ever interrupt one statement; retry once.
      if(hasMySqlErrorCode(error,"ER_QUERY_INTERRUPTED")){try{await this.execute(restore);return}catch(retryError){if(!failed)throw normalizeDrizzleError(retryError,"mysql");return}}
      if(!failed)throw normalizeDrizzleError(error,"mysql")
    }
  }
}

export interface DrizzleMySqlPersistenceProviderArgs{
  readonly db:MySqlDatabaseLike
  readonly registry:DrizzleMySqlEntityRegistry
  readonly maxPageSize?:number
  /** Unique index name ("index" or "table.index") → entity field, reported as ConflictError details.field. */
  readonly constraintMap?:Record<string,string>
}

export function createDrizzleMySqlPersistenceProvider(args:DrizzleMySqlPersistenceProviderArgs):InteractiveTransactionProvider{
  const maxPageSize=validateMySqlMaxPageSize(args.maxPageSize)
  const constraintMap=validateMySqlConstraintMap(args.constraintMap)
  const killPool=resolveKillPool(args.db)
  // conditionalAbacUpdate: updateOneWhere ANDs the compiled predicate into the single UPDATE statement.
  // transactionTimeouts: session max_execution_time/innodb_lock_wait_timeout plus a KILL QUERY watchdog,
  // which needs a pool to send KILL from a separate connection.
  const capabilities:PersistenceCapabilities={interactiveTransactions:true,atomicBatch:false,returningInsert:false,readSessions:false,jsonQueries:true,exactDecimal:false,persistentConnection:true,conditionalAbacUpdate:true,transactionTimeouts:killPool!==undefined,maxPageSize:maxPageSize??100,execution:Object.freeze({"transaction.interactive":{status:"proven",evidence:"framework-conformance/mysql1/mysql-guarantees.json"},"transaction.atomicBatch":{status:"unsupported"},"locking.pessimistic":{status:"unsupported"},"bulk.versioned.atomic":{status:"unsupported"},"bulk.versioned.partial":{status:"unsupported"},"read.streaming":{status:"unsupported"},"read.boundedPagedScan":{status:"proven",evidence:"framework-conformance/mysql1/mysql-guarantees.json"}})}
  const build=(db:MySqlDatabaseLike,nested:boolean):InteractiveTransactionProvider=>{
    function repository<T,TId=string>(entity:VersionedEntityDescriptor<T>):VersionedRepository<T,TId>
    function repository<T,TId=string>(entity:UnversionedEntityDescriptor<T>):UnversionedRepository<T,TId>
    function repository<T,TId=string>(entity:EntityDescriptor<T>):VersionedRepository<T,TId>|UnversionedRepository<T,TId>{const mapping=args.registry.get(entity.name,entity.namespace);if(!mapping)throw new ConfigurationError(`Entity ${entity.name} is not registered in the MySQL registry`);return createDrizzleMySqlRepository({db,table:mapping.table,entity:entity as never,columnMap:mapping.columnMap,...(capabilities.maxPageSize!==undefined?{maxPageSize:capabilities.maxPageSize}:{}),...(constraintMap!==undefined?{constraintMap}:{})}) as VersionedRepository<T,TId>|UnversionedRepository<T,TId>}
    const provider:InteractiveTransactionProvider={dialect:"mysql",capabilities:capabilities as PersistenceCapabilities&{interactiveTransactions:true},repository,async runInTransaction<TResult>(work:(scoped:InteractiveTransactionProvider)=>Promise<TResult>,options?:TransactionOptions):Promise<TResult>{
      if(nested)throw new ConfigurationError("Nested MySQL transactions are not supported")
      const timeoutMs=validateMySqlTransactionTimeout(options?.timeoutMs)
      const deadlineAt=timeoutMs===undefined?undefined:Date.now()+timeoutMs
      const config={...(options?.isolationLevel?{isolationLevel:options.isolationLevel}:{}),...(options?.accessMode?{accessMode:options.accessMode}:{})}
      let callbackCompleted=false
      let deadline:MySqlTransactionDeadline|undefined
      try{
        return await db.transaction(async tx=>{
          const scopedDb=tx as MySqlDatabaseLike
          if(deadlineAt===undefined){const result=await work(build(scopedDb,true));callbackCompleted=true;return result}
          const guard=deadline=new MySqlTransactionDeadline(scopedDb,killPool,deadlineAt)
          let result:TResult
          try{
            await guard.arm()
            result=await work(build(scopedDb,true))
            guard.disarm()
            // A transaction whose deadline passed is never committed, even if its last statement escaped the KILL.
            if(guard.fired)throw transactionTimeoutError("mysql",undefined,true)
          }catch(error){await guard.release(true);throw error}
          await guard.release(false)
          callbackCompleted=true
          return result
        },(Object.keys(config).length?config:undefined) as never)
      }catch(error){
        // Every path below failed before COMMIT was sent, so the transaction was rolled back.
        if(!callbackCompleted&&deadline!==undefined){
          if(deadline.fired)throw transactionTimeoutError("mysql",TIMEOUT_CODES.find(code=>hasMySqlErrorCode(error,code)),true)
          if(hasMySqlErrorCode(error,"ER_QUERY_TIMEOUT"))throw transactionTimeoutError("mysql","ER_QUERY_TIMEOUT",true)
          if(deadline.shortenedLockWait&&hasMySqlErrorCode(error,"ER_LOCK_WAIT_TIMEOUT"))throw transactionTimeoutError("mysql","ER_LOCK_WAIT_TIMEOUT",true)
        }
        throw classifyTransactionFailure(error,"mysql",callbackCompleted)
      }
    }};sessionByProvider.set(provider,db);return provider};return build(args.db,false)
}
