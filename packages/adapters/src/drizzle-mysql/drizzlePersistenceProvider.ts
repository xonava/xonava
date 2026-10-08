import {classifyTransactionFailure} from "../drizzle-shared/transactionOutcome"
import type {AnyMySqlTable} from "drizzle-orm/mysql-core"
import {ConfigurationError} from "core/domain"
import type { EntityDescriptor, InteractiveTransactionProvider, PersistenceProvider, TransactionOptions, UnversionedEntityDescriptor, UnversionedRepository, VersionedEntityDescriptor, VersionedRepository } from "core/persistence"
import type { PersistenceCapabilities } from "core/persistence"
import {createDrizzleMySqlRepository,type MySqlDatabaseLike} from "./drizzleRepository"
import type {DrizzleColumnMap} from "../drizzle-shared/predicateCompiler"

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

export function createDrizzleMySqlPersistenceProvider(args:{db:MySqlDatabaseLike;registry:DrizzleMySqlEntityRegistry;maxPageSize?:number}):InteractiveTransactionProvider{
  const maxPageSize=validateMySqlMaxPageSize(args.maxPageSize)
  // conditionalAbacUpdate: updateOneWhere ANDs the compiled predicate into the single UPDATE statement.
  const capabilities:PersistenceCapabilities={interactiveTransactions:true,atomicBatch:false,returningInsert:false,readSessions:false,jsonQueries:true,exactDecimal:false,persistentConnection:true,conditionalAbacUpdate:true,maxPageSize:maxPageSize??100,execution:Object.freeze({"transaction.interactive":{status:"proven",evidence:"framework-conformance/mysql1/mysql-guarantees.json"},"transaction.atomicBatch":{status:"unsupported"},"locking.pessimistic":{status:"unsupported"},"bulk.versioned.atomic":{status:"unsupported"},"bulk.versioned.partial":{status:"unsupported"},"read.streaming":{status:"unsupported"},"read.boundedPagedScan":{status:"proven",evidence:"framework-conformance/mysql1/mysql-guarantees.json"}})}
  const build=(db:MySqlDatabaseLike,nested:boolean):InteractiveTransactionProvider=>{
    function repository<T,TId=string>(entity:VersionedEntityDescriptor<T>):VersionedRepository<T,TId>
    function repository<T,TId=string>(entity:UnversionedEntityDescriptor<T>):UnversionedRepository<T,TId>
    function repository<T,TId=string>(entity:EntityDescriptor<T>):VersionedRepository<T,TId>|UnversionedRepository<T,TId>{const mapping=args.registry.get(entity.name,entity.namespace);if(!mapping)throw new ConfigurationError(`Entity ${entity.name} is not registered in the MySQL registry`);return createDrizzleMySqlRepository({db,table:mapping.table,entity:entity as never,columnMap:mapping.columnMap,...(capabilities.maxPageSize!==undefined?{maxPageSize:capabilities.maxPageSize}:{})}) as VersionedRepository<T,TId>|UnversionedRepository<T,TId>}
    const provider:InteractiveTransactionProvider={dialect:"mysql",capabilities:capabilities as PersistenceCapabilities&{interactiveTransactions:true},repository,async runInTransaction<TResult>(work:(scoped:InteractiveTransactionProvider)=>Promise<TResult>,options?:TransactionOptions):Promise<TResult>{if(nested)throw new ConfigurationError("Nested MySQL transactions are not supported");const config={...(options?.isolationLevel?{isolationLevel:options.isolationLevel}:{}),...(options?.accessMode?{accessMode:options.accessMode}:{})};let callbackCompleted=false;try{return await db.transaction(async tx=>{const result=await work(build(tx as MySqlDatabaseLike,true));callbackCompleted=true;return result},(Object.keys(config).length?config:undefined) as never)}catch(error){throw classifyTransactionFailure(error,"mysql",callbackCompleted)}}};sessionByProvider.set(provider,db);return provider};return build(args.db,false)
}
