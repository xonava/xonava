import { describe, expect, it } from "vitest"
import { defineAttachment } from ".."
import { hasObjectStoreCapability } from "../../bootstrap/runtimeCapabilities"
import { requireObjectStore } from "../../object-store/objectStore"

describe("O1 attachment and capability contracts",()=>{
  it("defines immutable scoped attachment metadata without binary content",()=>{ const createdAt=new Date("2026-09-12T00:00:00Z"); const attachment=defineAttachment({id:"a1",executionScope:{kind:"tenant",tenantId:"t1"},object:{bucket:"files",key:"t1/a1"},fileName:"report.pdf",contentType:"application/pdf",contentLength:42,checksum:{algorithm:"sha256",value:"abc"},createdAt}); createdAt.setTime(0); expect(attachment.executionScope).toEqual({kind:"tenant",tenantId:"t1"}); expect(attachment.createdAt).toBe("2026-09-12T00:00:00.000Z"); expect(Object.isFrozen(attachment)).toBe(true); expect(attachment).not.toHaveProperty("body") })
  it("rejects invalid metadata",()=>{ expect(()=>defineAttachment({id:"",executionScope:{kind:"tenant",tenantId:"t1"},object:{key:"x"},fileName:"x",contentType:"text/plain",contentLength:0,createdAt:new Date()})).toThrow() })
  it.each([
    { fileName: "" }, { contentType: "" }, { contentLength: -1 }, { contentLength: 1.5 },
    { contentLength: Number.MAX_SAFE_INTEGER + 1 }, { createdAt: new Date(Number.NaN) },
    { object: { key: "" } }, { executionScope: { kind: "tenant", tenantId: "" } },
  ])("rejects malformed attachment metadata %#", override => {
    expect(() => defineAttachment({ id: "a1", executionScope: { kind: "tenant", tenantId: "t1" }, object: { key: "t1/a1" }, fileName: "a.txt", contentType: "text/plain", contentLength: 1, createdAt: new Date("2026-09-12T00:00:00Z"), ...override } as never)).toThrow()
  })
  it("copies and freezes nested references while omitting an absent checksum",()=>{ const object={bucket:"files",key:"t1/a1"};const attachment=defineAttachment({id:"a1",executionScope:{kind:"tenant",tenantId:"t1"},object,fileName:"a.txt",contentType:"text/plain",contentLength:1,createdAt:new Date("2026-09-12T00:00:00Z")});object.key="changed";expect(attachment.object.key).toBe("t1/a1");expect(Object.isFrozen(attachment.object)).toBe(true);expect(attachment).not.toHaveProperty("checksum") })
  it("uses ObjectStore presence as the concrete capability",()=>{ const store={put:async()=>({key:"x",contentLength:0}),get:async()=>null,head:async()=>null,delete:async()=>false}; expect(hasObjectStoreCapability({objectStore:store})).toBe(true); expect(requireObjectStore(store)).toBe(store); expect(()=>requireObjectStore(undefined)).toThrow("not available") })
})
