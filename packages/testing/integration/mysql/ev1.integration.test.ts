import {describe,expect,it} from "vitest"
import type { InboxKey, InboxRecord, OutboxDeliveryRecord } from "@xonava/core/events"
import {createMySqlInboxStore,createMySqlLeaseStore,createMySqlOutboxStore} from "@xonava/adapters/drizzle-mysql"
import {openMySqlFixture} from "./database.js"

const scopeId="tenant:t1" as never
const provenance={format:"framework.authority-provenance",formatVersion:1} as never
const inboxKey:InboxKey={consumerKey:"ledger",messageId:"mysql-inbox",scopeId}
const inboxRecord:InboxRecord={...inboxKey,consumerDefinitionVersion:1,state:"pending",attempt:0,replayGeneration:0,claim:null,firstObservedAt:"",lastObservedAt:"",eventFormatVersion:1,eventPayloadVersion:1,originalProvenance:provenance,replay:{kind:"original-delivery"},history:[]}

describe("durable delivery and lease state machines",()=>{
  it("serializes inbox claims, fences expired owners, and persists acknowledgement",async()=>{
    const {pool}=await openMySqlFixture()
    try{
      const store=createMySqlInboxStore(pool)
      await store.observe(inboxRecord)
      const claims=await Promise.all([store.claim(inboxKey,"worker-a",60_000),store.claim(inboxKey,"worker-b",60_000)])
      expect(claims.filter(Boolean)).toHaveLength(1)
      const claim=claims.find(Boolean)!
      await store.acknowledge(inboxKey,claim.claim!.token,async()=>"committed")
      expect((await store.get(inboxKey))!.state).toBe("processed")

      const takeoverKey={...inboxKey,messageId:"mysql-inbox-takeover"}
      await store.observe({...inboxRecord,...takeoverKey})
      const first=await store.claim(takeoverKey,"first",1)
      await new Promise(resolve=>setTimeout(resolve,5))
      const second=await store.claim(takeoverKey,"second",60_000)
      expect(second!.claim!.token).not.toBe(first!.claim!.token)
      await expect(store.renew(takeoverKey,first!.claim!.token,1000)).rejects.toMatchObject({code:"STALE_CLAIM"})
    }finally{await pool.end()}
  })

  it("fences outbox publication and competing leases with database time",async()=>{
    const {pool}=await openMySqlFixture()
    try{
      const outbox=createMySqlOutboxStore(pool)
      const delivery:OutboxDeliveryRecord={envelope:{messageId:"mysql-outbox"} as never,scopeId,idempotencyKey:"mysql-outbox",state:"pending",attempt:0,claim:null}
      await outbox.append(delivery)
      const claims=await Promise.all([
        outbox.claim({messageId:"mysql-outbox",scopeId},"publisher-a",60_000),
        outbox.claim({messageId:"mysql-outbox",scopeId},"publisher-b",60_000)
      ])
      expect(claims.filter(Boolean)).toHaveLength(1)
      const claim=claims.find(Boolean)!
      await outbox.markPublished({messageId:"mysql-outbox",scopeId},claim.claim!.token)
      expect((await outbox.get({messageId:"mysql-outbox",scopeId}))!.state).toBe("published")

      const leases=createMySqlLeaseStore(pool)
      const resource={scopeId,namespace:"jobs",resourceId:"job-1"}
      const [first,second]=await Promise.all([leases.acquire(resource,"worker-a",60_000),leases.acquire(resource,"worker-b",60_000)])
      expect([first,second].filter(Boolean)).toHaveLength(1)
      const lease=(first??second)!
      await leases.assertCurrent(lease)
      await leases.release(lease)
      await expect(leases.assertCurrent(lease)).rejects.toMatchObject({code:"STALE_CLAIM"})
    }finally{await pool.end()}
  })
})
