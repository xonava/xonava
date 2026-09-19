import { CanonicalJsonError } from "./canonicalJson.js";
import {
  canonicalJsonString,
  canonicalJsonBytes,
  decodeCanonicalJson,
} from "./canonicalJson.js";
import {
  createEnvelope,
  parseEnvelope,
  isReadableVersion,
  UNSUPPORTED_FORMAT_ERROR,
  UNSUPPORTED_FORMAT_VERSION_ERROR,
  INVALID_ENVELOPE_ERROR,
  isValidFormatId,
  isValidVersion,
} from "./formatEnvelope.js";
import { SERIALIZATION_LIMIT_EXCEEDED_ERROR } from "../spec/formatVersions.js";
import { getFormatDefaultMaxBytes } from "./formatRegistry.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FormatVersion = number

export interface VersionedCodec<T> {
  readonly format: string;
  readonly currentVersion: FormatVersion;
  readonly readableVersions: readonly FormatVersion[];
  encode(value: T): JsonValue;
  decode(encoded: JsonValue): T;
}

export interface VersionedCodecConfig<T> {
  readonly format: string;
  readonly currentVersion: FormatVersion;
  readonly readableVersions: readonly FormatVersion[];
  readonly encode: (value: T) => JsonValue;
  readonly decode: (encoded: JsonValue) => T;
}

function assertCodecConfig<T>(config: VersionedCodecConfig<T>): void {
  if (!isValidFormatId(config.format)) {
    throw new CanonicalJsonError(`invalid codec format ${JSON.stringify(config.format)}`, {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  if (!isValidVersion(config.currentVersion)) {
    throw new CanonicalJsonError(`invalid codec currentVersion ${config.currentVersion}`, {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  if (config.readableVersions.length === 0) {
    throw new CanonicalJsonError("readableVersions must be non-empty", {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  for (const v of config.readableVersions) {
    if (!isValidVersion(v)) {
      throw new CanonicalJsonError(`invalid readableVersion ${v}`, {
        code: INVALID_ENVELOPE_ERROR,
      });
    }
  }
  if (!config.readableVersions.includes(config.currentVersion)) {
    throw new CanonicalJsonError(
      `readableVersions must include currentVersion ${config.currentVersion}`,
      { code: INVALID_ENVELOPE_ERROR },
    );
  }
  if (typeof config.encode !== "function" || typeof config.decode !== "function") {
    throw new CanonicalJsonError("codec encode/decode must be functions", {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
}

export function createVersionedCodec<T>(config: VersionedCodecConfig<T>): VersionedCodec<T> {
  assertCodecConfig(config);
  const readable = [...config.readableVersions] as readonly number[];
  const codec: VersionedCodec<T> = {
    format: config.format,
    currentVersion: config.currentVersion,
    readableVersions: readable,
    encode(value: T): JsonValue {
      const payload = config.encode(value);
      return createEnvelope(config.format, config.currentVersion, payload);
    },
    decode(encoded: JsonValue): T {
      const parsed = parseEnvelope(encoded);
      if (parsed.format !== config.format) {
        throw new CanonicalJsonError(
          `format mismatch: expected ${JSON.stringify(config.format)} got ${JSON.stringify(parsed.format)}`,
          { code: UNSUPPORTED_FORMAT_ERROR },
        );
      }
      if (!isReadableVersion(parsed.version, readable)) {
        throw new CanonicalJsonError(
          `unsupported version ${parsed.version} for format ${JSON.stringify(config.format)}; readable versions: [${readable.join(", ")}]`,
          { code: UNSUPPORTED_FORMAT_VERSION_ERROR },
        );
      }
      return config.decode(parsed.payload as JsonValue);
    },
  };
  return Object.freeze(codec);
}

export function encodeWithCodec<T>(codec: VersionedCodec<T>, value: T): JsonValue {
  return codec.encode(value);
}

export function decodeWithCodec<T>(codec: VersionedCodec<T>, encoded: JsonValue): T {
  return codec.decode(encoded);
}

export function encodeToString<T>(codec: VersionedCodec<T>, value: T): string {
  const jsonValue = encodeWithCodec(codec, value);
  const json = canonicalJsonString(jsonValue);
  const limit = getFormatDefaultMaxBytes(codec.format);
  if (limit !== undefined) {
    const bytes = new TextEncoder().encode(json).byteLength;
    if (bytes > limit) {
      throw new CanonicalJsonError(
        `encoded envelope bytes ${bytes} exceeds format default limit ${limit} for ${codec.format}`,
        { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR },
      );
    }
  }
  return json;
}

export function decodeFromString<T>(codec: VersionedCodec<T>, json: string): T {
  const limit = getFormatDefaultMaxBytes(codec.format);
  if (limit !== undefined && new TextEncoder().encode(json).byteLength > limit) {
    throw new CanonicalJsonError(`encoded envelope exceeds format default limit ${limit} for ${codec.format}`, { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR });
  }
  const decoded = decodeCanonicalJson(json) as JsonValue;
  return decodeWithCodec(codec, decoded);
}

export function encodeToBytes<T>(codec: VersionedCodec<T>, value: T): Uint8Array {
  const bytes = canonicalJsonBytes(encodeWithCodec(codec, value));
  const limit = getFormatDefaultMaxBytes(codec.format);
  if (limit !== undefined && bytes.byteLength > limit) {
    throw new CanonicalJsonError(
      `encoded envelope bytes ${bytes.byteLength} exceeds format default limit ${limit} for ${codec.format}`,
      { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR },
    );
  }
  return bytes;
}

export function decodeFromBytes<T>(codec: VersionedCodec<T>, bytes: Uint8Array): T {
  const limit = getFormatDefaultMaxBytes(codec.format);
  if (limit !== undefined && bytes.byteLength > limit) {
    throw new CanonicalJsonError(`encoded envelope exceeds format default limit ${limit} for ${codec.format}`, { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR });
  }
  const decoded = decodeCanonicalJson(bytes) as JsonValue;
  return decodeWithCodec(codec, decoded);
}

export function assertCodecReadable<T>(codec: VersionedCodec<T>, version: number): void {
  if (!isReadableVersion(version, codec.readableVersions)) {
    throw new CanonicalJsonError(
      `unsupported version ${version} for codec ${JSON.stringify(codec.format)}`,
      { code: UNSUPPORTED_FORMAT_VERSION_ERROR },
    );
  }
}

export function isCodecVersionReadable<T>(
  codec: VersionedCodec<T>,
  version: number,
): boolean {
  return isReadableVersion(version, codec.readableVersions);
}
