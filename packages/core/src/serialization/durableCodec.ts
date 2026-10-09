import { ConfigurationError, ValidationError } from "../domain/errors.js"
import { CanonicalJsonError, canonicalJsonString } from "./canonicalJson.js"

export interface DurableCodec<TValue = unknown, TEncoded = unknown> {
  readonly key: string
  encode(value: TValue): TEncoded
  decode(value: TEncoded): TValue
}

export type DurableCodecRegistry = Readonly<Record<string, DurableCodec>>
export interface DurableValueEnvelope { readonly codec: string; readonly value: unknown }

export function resolveDurableCodec(registry: DurableCodecRegistry, key: string): DurableCodec {
  const codec = typeof key === "string" && Object.hasOwn(registry, key) ? registry[key] : undefined
  if (!codec || typeof codec.encode !== "function" || typeof codec.decode !== "function") throw new ConfigurationError(`durable codec '${String(key)}' is not registered`)
  return codec
}

function canonicalOrUndefined(value: unknown): string | undefined {
  try { return canonicalJsonString(value) } catch (error) {
    if (error instanceof CanonicalJsonError) return undefined
    throw error
  }
}

/**
 * Proves a value survives encode → decode unchanged. JSON-representable values
 * are compared directly in canonical form, so a lossy codec is rejected. Values
 * with no canonical JSON form (Date, bigint, ...) are the reason codecs exist;
 * they are compared in the encoded domain instead: re-encoding the decoded
 * value must reproduce the same canonical durable encoding.
 */
export function assertDurableRoundTrip(codec: DurableCodec, value: unknown): void {
  let encoded: unknown
  let decoded: unknown
  try { encoded = codec.encode(value) } catch { throw new ValidationError(`durable codec '${codec.key}' could not encode the value`) }
  try { decoded = codec.decode(encoded) } catch { throw new ValidationError(`durable codec '${codec.key}' could not decode its encoded value`) }
  const original = canonicalOrUndefined(value)
  const restored = canonicalOrUndefined(decoded)
  if (original !== undefined || restored !== undefined) {
    if (original !== restored) throw new ValidationError(`durable codec '${codec.key}' did not round-trip the value`)
    return
  }
  let reencoded: unknown
  try { reencoded = codec.encode(decoded) } catch { throw new ValidationError(`durable codec '${codec.key}' could not re-encode its decoded value`) }
  const durable = canonicalOrUndefined(encoded)
  if (durable === undefined) throw new ValidationError(`durable codec '${codec.key}' must encode to canonical JSON`)
  if (canonicalOrUndefined(reencoded) !== durable) throw new ValidationError(`durable codec '${codec.key}' did not round-trip the value`)
}

export function encodeDurableValue(registry: DurableCodecRegistry, codecKey: string, value: unknown): DurableValueEnvelope {
  const codec = resolveDurableCodec(registry, codecKey)
  const encoded = codec.encode(value)
  return Object.freeze({ codec: codecKey, value: encoded })
}

export function decodeDurableValue(registry: DurableCodecRegistry, envelope: DurableValueEnvelope): unknown {
  return resolveDurableCodec(registry, envelope.codec).decode(envelope.value)
}
