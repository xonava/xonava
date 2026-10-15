import { enforceRateLimit } from "@xonava/core/rate-limit"
import { createNoopTelemetry } from "@xonava/core/telemetry"
export const capabilities = [enforceRateLimit, createNoopTelemetry]
