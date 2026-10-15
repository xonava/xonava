import { CacheService } from "@xonava/core/cache"
import { createNoopTelemetry } from "@xonava/core/telemetry"
export const capabilities = [CacheService, createNoopTelemetry]
