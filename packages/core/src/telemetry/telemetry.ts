import type { DataClassification, FieldDataClassifications } from "../domain/dataClassification"
import { fieldsAllowedForPurpose } from "../domain/dataClassification"
import { ValidationError } from "../domain/errors"

export type TelemetryAttributeValue=string|number|boolean
export type TelemetrySeverity="debug"|"info"|"warn"|"error"
export interface TelemetryEvent { readonly name:string; readonly severity:TelemetrySeverity; readonly timestamp:Date; readonly attributes:Readonly<Record<string,TelemetryAttributeValue>> }
export interface TelemetryPort { emit(event:TelemetryEvent):void|Promise<void> }

export function buildSafeTelemetryAttributes(values:Readonly<Record<string,unknown>>,classifications:FieldDataClassifications):Readonly<Record<string,TelemetryAttributeValue>>{
  const allowed=new Set(fieldsAllowedForPurpose(classifications,"telemetry"));const output:Record<string,TelemetryAttributeValue>={}
  for(const [key,value] of Object.entries(values)){if(!allowed.has(key)||!(typeof value==="string"||typeof value==="number"||typeof value==="boolean")||!Number.isFinite(typeof value==="number"?value:0))continue;if(typeof value==="string"&&new TextEncoder().encode(value).byteLength>1024)throw new ValidationError(`Telemetry attribute '${key}' exceeds 1024 bytes`);output[key]=value}
  return Object.freeze(output)
}
export function explicitlySafeTelemetryAttributes(values:Readonly<Record<string,TelemetryAttributeValue>>,classification:DataClassification="internal"):Readonly<Record<string,TelemetryAttributeValue>>{return buildSafeTelemetryAttributes(values,Object.fromEntries(Object.keys(values).map(key=>[key,classification])))}
/** Telemetry is observational and must never alter framework semantics. */
export function emitTelemetry(port:TelemetryPort|undefined,event:TelemetryEvent):void{if(!port)return;try{const result=port.emit(Object.freeze({...event,attributes:Object.freeze({...event.attributes})}));if(result&&typeof (result).catch==="function")void (result).catch(()=>undefined)}catch{/* best effort */}}
export function createNoopTelemetry():TelemetryPort{return {emit(){}}}

export const MAX_TELEMETRY_LOG_ATTRIBUTES = 32
export const MAX_TELEMETRY_LOG_STRING_BYTES = 1024

export interface TelemetryLogger {
  debug(message: string, data?: Readonly<Record<string, unknown>>): void
  info(message: string, data?: Readonly<Record<string, unknown>>): void
  warn(message: string, data?: Readonly<Record<string, unknown>>): void
  error(message: string, data?: Readonly<Record<string, unknown>>): void
}

const logEncoder = new TextEncoder()

/** Replacement value for attributes whose key names a secret. */
export const TELEMETRY_REDACTED = "[REDACTED]"

/**
 * Key fragments that mark a log attribute as secret. Keys are compared
 * case-insensitively with `_`, `-`, `.` and spaces removed, and a key matches
 * when it contains any fragment: password, passwd, secret, token (claimToken,
 * accessToken, refresh_token...), authorization, cookie, apikey (apiKey,
 * api_key), credential, privatekey, sessionid, session, jwt, bearer,
 * signature. Matching values are replaced by TELEMETRY_REDACTED whatever their
 * type. The match is deliberately broad: over-redacting an operational
 * attribute is preferable to leaking a secret.
 */
export const SENSITIVE_TELEMETRY_KEY_PATTERNS: readonly string[] = Object.freeze(["password", "passwd", "secret", "token", "authorization", "cookie", "apikey", "credential", "privatekey", "sessionid", "session", "jwt", "bearer", "signature"])

/**
 * Short secret words matched only as whole key segments (camelCase, snake_case,
 * kebab-case, dotted or spaced words), because as substrings they occur inside
 * ordinary words: `auth` (authHeader, x-auth, but not author) and `otp`
 * (otp_code, userOTP, but not footprint).
 */
export const SENSITIVE_TELEMETRY_KEY_SEGMENTS: readonly string[] = Object.freeze(["auth", "otp"])

/**
 * Splits a key into lower-case words at camelCase boundaries and at whitespace, `_`, `.` and `-`. A single pass: the equivalent
 * `/([A-Z]+)([A-Z][a-z])/g` replacement backtracks quadratically on a long run of capitals (200 kB took ~17 s), and keys passed to
 * the exported isSensitiveTelemetryKey are not length-bounded.
 */
function telemetryKeySegments(key: string): string[] {
  const upper = (c: string): boolean => c >= "A" && c <= "Z"
  const lower = (c: string): boolean => c >= "a" && c <= "z"
  let spaced = ""
  let copied = 0
  for (let i = 1; i < key.length; i += 1) {
    const current = key[i]!
    if (!upper(current)) continue
    const previous = key[i - 1]!
    // "orderID" -> "order ID", "XMLHttp" -> "XML Http": split before a capital that follows a lower-case letter or digit, or that
    // starts a capitalised word right after another capital.
    if (lower(previous) || (previous >= "0" && previous <= "9") || (upper(previous) && i + 1 < key.length && lower(key[i + 1]!))) {
      spaced += key.slice(copied, i) + " "
      copied = i
    }
  }
  return (spaced + key.slice(copied)).toLowerCase().split(/[\s_.-]+/)
}

/** Whether a telemetry attribute key names a secret (see SENSITIVE_TELEMETRY_KEY_PATTERNS and SENSITIVE_TELEMETRY_KEY_SEGMENTS). */
export function isSensitiveTelemetryKey(key: string): boolean {
  const text = String(key)
  const normalized = text.toLowerCase().replace(/[\s_.-]/g, "")
  if (SENSITIVE_TELEMETRY_KEY_PATTERNS.some((pattern) => normalized.includes(pattern))) return true
  return telemetryKeySegments(text).some((segment) => SENSITIVE_TELEMETRY_KEY_SEGMENTS.includes(segment))
}

function boundedTelemetryString(value: string): string {
  if (value.length <= MAX_TELEMETRY_LOG_STRING_BYTES / 4) return value
  if (logEncoder.encode(value).byteLength <= MAX_TELEMETRY_LOG_STRING_BYTES) return value
  // Cut on a code-point boundary well under the byte budget, then mark it.
  let cut = ""
  for (const character of value) {
    if (logEncoder.encode(cut + character).byteLength > MAX_TELEMETRY_LOG_STRING_BYTES - 16) break
    cut += character
  }
  return `${cut}…[truncated]`
}

/**
 * Converts operational log data into bounded telemetry attributes. Only
 * primitive values survive (objects, arrays, functions, and non-finite numbers
 * are dropped), values under sensitive keys (SENSITIVE_TELEMETRY_KEY_PATTERNS)
 * are replaced by TELEMETRY_REDACTED, strings are truncated rather than
 * rejected, and the attribute count is capped. It never throws, so logging can
 * never alter semantics.
 */
export function boundedTelemetryAttributes(message: string, data?: Readonly<Record<string, unknown>>): Readonly<Record<string, TelemetryAttributeValue>> {
  const output: Record<string, TelemetryAttributeValue> = Object.create(null) as Record<string, TelemetryAttributeValue>
  output.message = boundedTelemetryString(String(message))
  let count = 1
  if (data && typeof data === "object") {
    for (const key of Object.keys(data)) {
      if (count >= MAX_TELEMETRY_LOG_ATTRIBUTES) break
      if (key === "message" || key.length > 64) continue
      const value = data[key]
      if (isSensitiveTelemetryKey(key) && (typeof value === "string" || typeof value === "boolean" || typeof value === "number" || value instanceof Date)) output[key] = TELEMETRY_REDACTED
      else if (typeof value === "string") output[key] = boundedTelemetryString(value)
      else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) output[key] = value
      else if (value instanceof Date && Number.isFinite(value.getTime())) output[key] = value.toISOString()
      else continue
      count++
    }
  }
  return Object.freeze(output)
}

/** A structured, bounded, non-throwing logger over a TelemetryPort. */
export function createTelemetryLogger(port: TelemetryPort | undefined, eventName: string, now: () => Date = () => new Date()): TelemetryLogger {
  const write = (severity: TelemetrySeverity, message: string, data?: Readonly<Record<string, unknown>>): void => {
    if (!port) return
    try {
      let timestamp = now()
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) timestamp = new Date()
      emitTelemetry(port, { name: eventName, severity, timestamp, attributes: boundedTelemetryAttributes(message, data) })
    } catch {
      // Telemetry is observational and must never alter framework semantics.
    }
  }
  return Object.freeze({
    debug: (message: string, data?: Readonly<Record<string, unknown>>) => write("debug", message, data),
    info: (message: string, data?: Readonly<Record<string, unknown>>) => write("info", message, data),
    warn: (message: string, data?: Readonly<Record<string, unknown>>) => write("warn", message, data),
    error: (message: string, data?: Readonly<Record<string, unknown>>) => write("error", message, data),
  })
}
