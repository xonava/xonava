import { CacheService } from "core/cache"
import { createNoopTelemetry } from "core/telemetry"
export const capabilities = [CacheService, createNoopTelemetry]
