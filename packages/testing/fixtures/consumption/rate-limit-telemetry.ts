import { enforceRateLimit } from "core/rate-limit"
import { createNoopTelemetry } from "core/telemetry"
export const capabilities = [enforceRateLimit, createNoopTelemetry]
