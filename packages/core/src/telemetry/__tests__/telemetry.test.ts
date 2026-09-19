import { describe,expect,it,vi } from "vitest"
import { buildSafeTelemetryAttributes,emitTelemetry,explicitlySafeTelemetryAttributes } from "../telemetry"
import { createOperationServices } from "../../operation/operationServices"
import { createExecutionContext } from "../../execution/executionContext"
import { createOperationContext } from "../../operation/operationContext"

describe("T1 unified telemetry",()=>{
  it("includes only public/internal primitive attributes",()=>{expect(buildSafeTelemetryAttributes({public:"ok",internal:2,secret:"no",object:{x:1}},{public:"public",internal:"internal",secret:"confidential",object:"public"})).toEqual({public:"ok",internal:2})})
  it("bounds safe string attributes",()=>{expect(()=>explicitlySafeTelemetryAttributes({value:"x".repeat(1100)})).toThrow("1024")})
  it("never changes application semantics when a sink throws or rejects",async()=>{expect(()=>emitTelemetry({emit(){throw new Error("down")}},{name:"x",severity:"info",timestamp:new Date(),attributes:{}})).not.toThrow();emitTelemetry({emit:async()=>{throw new Error("down")}},{name:"x",severity:"info",timestamp:new Date(),attributes:{}});await Promise.resolve()})
  it("uses unified telemetry without forwarding execution payloads",()=>{const emit=vi.fn();const telemetry={emit};expect(createOperationServices({telemetry}).telemetry).toBe(telemetry);const context=createExecutionContext({jobId:"j",jobType:"job",jobVersion:1,attempt:1,tenantId:null,executionScope:{kind:"system",systemKey:"framework"},correlationId:"c",startedAt:new Date(),telemetry,assertLease:async()=>{}});expect(context.telemetry).toBe(telemetry);expect(JSON.stringify(emit.mock.calls)).not.toContain("secret")})
})
