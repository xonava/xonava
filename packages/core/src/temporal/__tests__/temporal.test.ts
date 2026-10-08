import { describe, expect, it, vi } from "vitest"
import { reconstructAsOf, validateTemporalRevision, validateTemporalSnapshot, type TemporalHistoryStore, type TemporalRevision } from ".."
import { encodeExecutionScopeId } from "../../domain"
const resource = { scopeId: encodeExecutionScopeId({kind:"system",systemKey:"test"}), entityType: "person", entityId: "p1" } as const
const rev = (revision: number, occurredAt: string, state: Record<string, unknown> | null, kind: TemporalRevision["kind"] = state ? revision === 1 ? "created" : "updated" : "deleted"): TemporalRevision => ({ ...resource, revision, occurredAt: new Date(occurredAt), kind, state })
function store(items: TemporalRevision[], snapshot: Awaited<ReturnType<TemporalHistoryStore["latestSnapshot"]>> = null): TemporalHistoryStore {
  return { append: vi.fn(), saveSnapshot: vi.fn(), latestSnapshot: vi.fn(async () => snapshot), revisions: vi.fn(async (_r, o) => { const found=items.filter(x=>x.revision>o.afterRevision&&x.occurredAt<=o.asOf).slice(0,o.limit); return {items:found,hasMore:items.some(x=>x.revision>(found.at(-1)?.revision??o.afterRevision)&&x.occurredAt<=o.asOf)} }) }
}
describe("temporal reconstruction",()=>{
  it("reconstructs state at exact historical instants",async()=>{const s=store([rev(1,"2026-01-01T00:00:00Z",{name:"A"}),rev(2,"2026-02-01T00:00:00Z",{name:"B"})]);expect((await reconstructAsOf(s,resource,new Date("2026-01-15"))).state).toEqual({name:"A"});expect((await reconstructAsOf(s,resource,new Date("2026-02-01"))).state).toEqual({name:"B"})})
  it("starts from a snapshot and replays only later revisions",async()=>{const s=store([rev(3,"2026-03-01T00:00:00Z",{n:3})],{...resource,revision:2,occurredAt:new Date("2026-02-01"),state:{n:2}});const out=await reconstructAsOf(s,resource,new Date("2026-04-01"));expect(out).toMatchObject({revision:3,state:{n:3},replayedRevisions:1});expect(s.revisions).toHaveBeenCalledWith(resource,expect.objectContaining({afterRevision:2}))})
  it("represents deletion and restoration explicitly",async()=>{const s=store([rev(1,"2026-01-01",{n:1}),rev(2,"2026-02-01",null,"deleted"),rev(3,"2026-03-01",{n:2},"restored")]);expect((await reconstructAsOf(s,resource,new Date("2026-02-15"))).deleted).toBe(true);expect((await reconstructAsOf(s,resource,new Date("2026-04-01"))).state).toEqual({n:2})})
  it("rejects gaps, foreign resources, future records, and empty continuing pages",async()=>{await expect(reconstructAsOf(store([rev(2,"2026-01-01",{n:2})]),resource,new Date("2026-02-01"))).rejects.toThrow(/contiguous/);await expect(reconstructAsOf(store([{...rev(1,"2026-01-01",{n:1}),entityId:"other"}]),resource,new Date("2026-02-01"))).rejects.toThrow(/outside/);const broken={...store([]),revisions:async()=>({items:[],hasMore:true})};await expect(reconstructAsOf(broken,resource,new Date())).rejects.toThrow(/invalid revision page/)})
  it("bounds replay across pages",async()=>{await expect(reconstructAsOf(store([rev(1,"2026-01-01",{n:1}),rev(2,"2026-01-02",{n:2})]),resource,new Date("2026-02-01"),{maxRevisions:1,pageSize:1})).rejects.toThrow(/limit/)})
  it("keeps temporal revisions distinct from OCC versions",()=>{expect(validateTemporalRevision({...rev(7,"2026-01-01",{n:1}),entityVersion:2})).toMatchObject({revision:7,entityVersion:2})})
  it("isolates revision, reconstruction, and nested state timestamps",async()=>{const occurredAt=new Date("2026-01-01T00:00:00.000Z"),nestedAt=new Date("2025-12-01T00:00:00.000Z");const checked=validateTemporalRevision({...resource,revision:1,occurredAt,kind:"created",state:{nested:{dates:[nestedAt]}}});occurredAt.setTime(0);nestedAt.setTime(0);checked.occurredAt.setTime(1);((checked.state!.nested as {dates:Date[]}).dates[0]!).setTime(1);expect(checked.occurredAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");expect((checked.state!.nested as {dates:Date[]}).dates[0]!.toISOString()).toBe("2025-12-01T00:00:00.000Z");const asOf=new Date("2026-02-01T00:00:00.000Z");const out=await reconstructAsOf(store([checked]),resource,asOf);asOf.setTime(0);out.asOf.setTime(1);expect(out.asOf.toISOString()).toBe("2026-02-01T00:00:00.000Z");expect(Object.isFrozen(out.state)).toBe(true)})
  it("re-validates trusted temporal revisions and snapshots",()=>{const revision=validateTemporalRevision(rev(1,"2026-01-01",{at:new Date("2025-12-01")}));const checkedAgain=validateTemporalRevision(revision);expect(checkedAgain.occurredAt).toEqual(revision.occurredAt);expect((checkedAgain.state!.at as Date).toISOString()).toBe("2025-12-01T00:00:00.000Z");const snapshot=validateTemporalSnapshot({...resource,revision:1,occurredAt:new Date("2026-01-01"),state:{at:new Date("2025-12-01")}});expect(validateTemporalSnapshot(snapshot)).toEqual(snapshot)})
  it("rejects invalid outer and nested timestamps",()=>{expect(()=>validateTemporalRevision({...rev(1,"2026-01-01",{n:1}),occurredAt:new Date(NaN)})).toThrow();expect(()=>validateTemporalRevision(rev(1,"2026-01-01",{at:new Date(NaN)}))).toThrow(/invalid date/)})
  it("validates lifecycle/state consistency and identities",()=>{expect(()=>validateTemporalRevision({...rev(1,"2026-01-01",{n:1}),kind:"deleted"})).toThrow(/null state/);expect(()=>validateTemporalRevision({...rev(1,"2026-01-01",null),kind:"updated"})).toThrow(/must have state/);expect(()=>validateTemporalRevision({...rev(1,"2026-01-01",{n:1}),eventId:"bad id"})).toThrow(/identity/)})
  it("rejects invalid lifecycle transitions",async()=>{await expect(reconstructAsOf(store([rev(1,"2026-01-01",{n:1},"updated")]),resource,new Date("2026-02-01"))).rejects.toThrow(/begin with creation/);await expect(reconstructAsOf(store([rev(1,"2026-01-01",{n:1}),rev(2,"2026-01-02",null,"deleted"),rev(3,"2026-01-03",{n:2},"updated")]),resource,new Date("2026-02-01"))).rejects.toThrow(/restored/)})
})

describe("temporal snapshot identity (final pass)",()=>{
  it("rejects a snapshot for another resource",async()=>{
    const foreign={scopeId:resource.scopeId,entityType:"other",entityId:"x9",revision:5,occurredAt:new Date("2026-01-01T00:00:00Z"),state:{secret:1}}
    await expect(reconstructAsOf(store([],foreign),resource,new Date("2026-02-01"))).rejects.toThrow("snapshot outside the request")
  })
  it("rejects a revision-0 snapshot that carries state",()=>{
    expect(()=>validateTemporalSnapshot({...resource,revision:0,occurredAt:new Date("2026-01-01T00:00:00Z"),state:{ghost:true}})).toThrow("revision-0")
  })
})

describe("temporal replay limit defaults",()=>{
  it("accepts a revision limit below the default page size",async()=>{
    const s=store([rev(1,"2026-01-01",{n:1}),rev(2,"2026-01-02",{n:2})])
    await expect(reconstructAsOf(s,resource,new Date("2026-02-01"),{maxRevisions:100})).resolves.toMatchObject({revision:2,state:{n:2}})
    expect(s.revisions).toHaveBeenCalledWith(resource,expect.objectContaining({limit:100}))
  })
  it("still rejects an explicit page size above the revision limit",async()=>{
    await expect(reconstructAsOf(store([]),resource,new Date(),{maxRevisions:10,pageSize:11})).rejects.toThrow(/replay limits/)
  })
})
