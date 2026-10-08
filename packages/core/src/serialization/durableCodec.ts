import { ConfigurationError, ValidationError } from "../domain/errors.js"
import { canonicalJsonString } from "./canonicalJson.js"

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

/**
 * Proves a value survives encode → decode unchanged. Values are compared by
 * their canonical JSON form, so a lossy codec (or a value with no canonical
 * representation) is rejected instead of silently persisting different data.
 */
export function assertDurableRoundTrip(codec: DurableCodec, value: unknown): void {
  let encoded: unknown
  let decoded: unknown
  try { encoded = codec.encode(value) } catch { throw new ValidationError(`durable codec '${codec.key}' could not encode the value`) }
  try { decoded = codec.decode(encoded) } catch { throw new ValidationError(`durable codec '${codec.key}' could not decode its encoded value`) }
  let same: boolean
  try { same = canonicalJsonString(decoded) === canonicalJsonString(value) } catch { throw new ValidationError(`durable codec '${codec.key}' round trip is not canonically comparable`) }
  if (!same) throw new ValidationError(`durable codec '${codec.key}' did not round-trip the value`)
}

export function encodeDurableValue(registry: DurableCodecRegistry, codecKey: string, value: unknown): DurableValueEnvelope {
  const codec = resolveDurableCodec(registry, codecKey)
  const encoded = codec.encode(value)
  return Object.freeze({ codec: codecKey, value: encoded })
}

export function decodeDurableValue(registry: DurableCodecRegistry, envelope: DurableValueEnvelope): unknown {
  return resolveDurableCodec(registry, envelope.codec).decode(envelope.value)
}
