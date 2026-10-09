import { CanonicalJsonError } from "./canonicalJson.js";

export const INVALID_ENVELOPE_ERROR = "INVALID_DURABLE_ENVELOPE" as const;
export const UNSUPPORTED_FORMAT_ERROR = "UNSUPPORTED_DURABLE_FORMAT" as const;
export const UNSUPPORTED_FORMAT_VERSION_ERROR =
  "UNSUPPORTED_DURABLE_FORMAT_VERSION" as const;

export interface FormatEnvelope {
  readonly format: string;
  readonly version: number;
}

export interface VersionedEnvelope<T> extends FormatEnvelope {
  readonly payload: T;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const FORMAT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

export function isValidFormatId(format: string): boolean {
  if (typeof format !== "string") return false;
  if (format.length === 0 || format.length > 256) return false;
  return FORMAT_ID_PATTERN.test(format);
}

export function isValidVersion(version: number): boolean {
  return Number.isInteger(version) && version >= 1 && version <= Number.MAX_SAFE_INTEGER;
}

export function isReadableVersion(
  version: number,
  readableVersions: readonly number[],
): boolean {
  return readableVersions.includes(version);
}

export function isVersionSupported(
  version: number,
  readableVersions: readonly number[],
): boolean {
  return isReadableVersion(version, readableVersions);
}

export function assertReadableVersion(
  version: number,
  readableVersions: readonly number[],
  format?: string,
): void {
  if (!isValidVersion(version)) {
    throw new CanonicalJsonError(`invalid version ${version}`, {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  if (!isReadableVersion(version, readableVersions)) {
    const label = format !== undefined ? ` for format ${JSON.stringify(format)}` : "";
    throw new CanonicalJsonError(
      `unsupported durable format version ${version}${label}; readable versions: [${readableVersions.join(", ")}]`,
      { code: UNSUPPORTED_FORMAT_VERSION_ERROR },
    );
  }
}

export function createEnvelope(
  format: string,
  version: number,
  payload: unknown,
): JsonValue {
  if (!isValidFormatId(format)) {
    throw new CanonicalJsonError(`invalid format id ${JSON.stringify(format)}`, {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  if (!isValidVersion(version)) {
    throw new CanonicalJsonError(`invalid format version ${version}`, {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  if (payload === undefined) {
    // JSON serialization would drop the member and produce an envelope without a payload.
    throw new CanonicalJsonError("envelope payload must not be undefined", { code: INVALID_ENVELOPE_ERROR });
  }
  const envelope: Record<string, unknown> = {
    format,
    version,
    payload,
  };
  return envelope as unknown as JsonValue;
}

export function parseEnvelope(envelope: unknown): {
  readonly format: string;
  readonly version: number;
  readonly payload: unknown;
} {
  if (!isPlainObject(envelope)) {
    throw new CanonicalJsonError("envelope must be a plain object", {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  const raw = envelope;
  const formatRaw = raw["format"];
  const versionRaw = raw["version"];

  if (typeof formatRaw !== "string" || !isValidFormatId(formatRaw)) {
    throw new CanonicalJsonError(`invalid envelope format ${JSON.stringify(formatRaw)}`, {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  if (typeof versionRaw !== "number" || !isValidVersion(versionRaw)) {
    throw new CanonicalJsonError(`invalid envelope version ${JSON.stringify(versionRaw)}`, {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  // A durable envelope is exactly { format, version, payload }: a missing
  // payload would hand `undefined` to the payload decoder (partial decoding),
  // and an unknown member is data the reader would silently drop.
  if (!Object.hasOwn(raw, "payload")) {
    throw new CanonicalJsonError("envelope is missing its payload", { code: INVALID_ENVELOPE_ERROR });
  }
  const unknown = Object.keys(raw).filter((key) => key !== "format" && key !== "version" && key !== "payload");
  if (unknown.length > 0) {
    throw new CanonicalJsonError(`envelope has unknown members ${JSON.stringify(unknown)}`, { code: INVALID_ENVELOPE_ERROR });
  }
  const payload = raw["payload"];
  return {
    format: formatRaw,
    version: versionRaw,
    payload,
  };
}

export function validateEnvelope(
  envelope: unknown,
): asserts envelope is FormatEnvelope & { payload: unknown } {
  parseEnvelope(envelope);
}

export function assertEnvelopeVersionSupported(
  envelope: FormatEnvelope,
  readableVersions: readonly number[],
): void {
  assertReadableVersion(envelope.version, readableVersions, envelope.format);
}

export function isEnvelopeReadable(
  envelope: FormatEnvelope,
  readableVersions: readonly number[],
): boolean {
  return isReadableVersion(envelope.version, readableVersions);
}
