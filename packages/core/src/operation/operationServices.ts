import { createNoopTelemetry, type TelemetryPort } from "../telemetry/telemetry"

export interface OperationServices {
  readonly clock: Clock
  readonly idGenerator: () => string
  readonly telemetry: TelemetryPort
}

export function createOperationServices(args?: {
  clock?: Clock
  idGenerator?: () => string
  telemetry?: TelemetryPort
}): OperationServices {
  const telemetry=args?.telemetry??createNoopTelemetry()
  return {
    clock: args?.clock ?? { now: () => new Date() },
    idGenerator: args?.idGenerator ?? (() => crypto.randomUUID()),
    telemetry,
  }
}

import type { Clock } from "./deadline"
