import {describe,expect,it} from "vitest"
import {Predicate,type ExecutionScope} from "core/domain"
import type { VersionedEntityDescriptor } from "core/persistence"
import { createTenantScopedPersistenceProvider } from "core/persistence"
import {createDrizzleMySqlPersistenceProvider,DrizzleMySqlEntityRegistry} from "adapters/drizzle-mysql"
import {mysqlRecords} from "../../fixtures/mysql/schema.js"
import {openMySqlFixture} from "./database.js"
interface RecordRow{id:string;tenantId:string;name:string;version:number;value:unknown}
const entity:VersionedEntityDescriptor<RecordRow>={name:"records",primaryKey:"id",versionField:"version",tenantField:"tenantId",fields:{id:{type:"string"},tenantId:{type:"string"},name:{type:"string"},version:{type:"number"},value:{type:"json"}}}
describe("MYSQL1 repository integration",()=>{it("enforces tenant scope and conditional OCC on a real server",async()=>{const fixture=await openMySqlFixture();try{const registry=new DrizzleMySqlEntityRegistry().register(entity,mysqlRecords,{id:mysqlRecords.id,tenantId:mysqlRecords.tenantId,name:mysqlRecords.name,version:mysqlRecords.version,value:mysqlRecords.value});const provider=createTenantScopedPersistenceProvider(createDrizzleMySqlPersistenceProvider({db:fixture.db,registry}),"tenant-a");const repository=provider.repository(entity);await repository.insert({id:"r1",tenantId:"tenant-a",name:"one",value:{n:1}});await expect(repository.update("r1",{name:"two"},{optimisticConcurrency:{expectedVersion:1}})).resolves.toMatchObject({version:2,name:"two"});await expect(repository.update("r1",{name:"stale"},{optimisticConcurrency:{expectedVersion:1}})).rejects.toMatchObject({code:"OPTIMISTIC_CONCURRENCY_FAILED"});await fixture.pool.query("INSERT INTO records(id,tenant_id,name,version,value) VALUES('other','tenant-b','hidden',1,JSON_OBJECT())");expect((await repository.findMany({filter:Predicate.literal(true)})).rows.map(row=>row.id)).toEqual(["r1"])}finally{await fixture.pool.end()}})})
