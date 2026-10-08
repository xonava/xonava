import { readonlyMap } from "../kernel/readonlyCollections.js";
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity.js";
import { CanonicalJsonError } from "./canonicalJson.js";
import {
  DURABLE_FORMAT_REGISTRY_V1,
  FORMAT_DEFAULT_MAX_CANONICAL_BYTES,
  type DurableFormatRegistration,
} from "../spec/formatVersions.js";
import {
  UNSUPPORTED_FORMAT_ERROR,
  UNSUPPORTED_FORMAT_VERSION_ERROR,
  INVALID_ENVELOPE_ERROR,
  isValidFormatId,
  isValidVersion,
  isReadableVersion,
} from "./formatEnvelope.js";

export type { DurableFormatRegistration } from "../spec/formatVersions.js";

export interface CompiledDurableFormat extends DurableFormatRegistration {
  readonly readableVersions: readonly number[];
}

export interface CompiledDurableFormatRegistry {
  readonly entries: readonly CompiledDurableFormat[];
  readonly byFormatId: ReadonlyMap<string, CompiledDurableFormat>;
}

const READABLE_VERSIONS_V1: readonly number[] = Object.freeze([1]);

function buildCompiledRegistry(
  entries: readonly DurableFormatRegistration[],
): CompiledDurableFormatRegistry {
  const compiled: CompiledDurableFormat[] = entries.map((entry) => cloneAndFreezeDefinition({
    ...entry,
    readableVersions: READABLE_VERSIONS_V1,
  }));
  const map = new Map<string, CompiledDurableFormat>();
  for (const entry of compiled) {
    map.set(entry.formatId, entry);
  }
  return Object.freeze({
    entries: Object.freeze(compiled),
    byFormatId: readonlyMap(map),
  });
}

export const COMPILED_DURABLE_FORMAT_REGISTRY_V1: CompiledDurableFormatRegistry =
  buildCompiledRegistry(DURABLE_FORMAT_REGISTRY_V1);

export function validateRegistry(
  entries: readonly DurableFormatRegistration[] = DURABLE_FORMAT_REGISTRY_V1,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isValidFormatId(entry.formatId)) {
      throw new CanonicalJsonError(`invalid formatId ${JSON.stringify(entry.formatId)}`, {
        code: INVALID_ENVELOPE_ERROR,
      });
    }
    if (seen.has(entry.formatId)) {
      throw new CanonicalJsonError(`duplicate formatId ${JSON.stringify(entry.formatId)}`, {
        code: INVALID_ENVELOPE_ERROR,
      });
    }
    seen.add(entry.formatId);
    if (!isValidVersion(entry.formatVersion)) {
      throw new CanonicalJsonError(
        `invalid formatVersion ${entry.formatVersion} for ${entry.formatId}`,
        { code: INVALID_ENVELOPE_ERROR },
      );
    }
    if (entry.kind !== "framework-envelope" && entry.kind !== "identity-encoding") {
      throw new CanonicalJsonError(`invalid kind ${JSON.stringify((entry as { kind: unknown }).kind)}`, {
        code: INVALID_ENVELOPE_ERROR,
      });
    }
  }
}

export function listFormats(): readonly DurableFormatRegistration[] {
  return COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries;
}

export function listCompiledFormats(): readonly CompiledDurableFormat[] {
  return COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries;
}

export function getFormatRegistration(
  formatId: string,
): DurableFormatRegistration | undefined {
  ensureRegistryValid();
  return COMPILED_DURABLE_FORMAT_REGISTRY_V1.byFormatId.get(formatId);
}

export function getCompiledFormat(
  formatId: string,
): CompiledDurableFormat | undefined {
  return COMPILED_DURABLE_FORMAT_REGISTRY_V1.byFormatId.get(formatId);
}

export function getReadableVersions(
  formatId: string,
): readonly number[] | undefined {
  const entry = getCompiledFormat(formatId);
  return entry?.readableVersions;
}

export function isFormatVersionReadable(
  formatId: string,
  version: number,
): boolean {
  const versions = getReadableVersions(formatId);
  if (versions === undefined) return false;
  return isReadableVersion(version, versions);
}

export function assertFormatSupported(formatId: string, version: number): void {
  if (!isValidFormatId(formatId)) {
    throw new CanonicalJsonError(`invalid format id ${JSON.stringify(formatId)}`, {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  if (!isValidVersion(version)) {
    throw new CanonicalJsonError(`invalid version ${version}`, {
      code: INVALID_ENVELOPE_ERROR,
    });
  }
  const entry = getCompiledFormat(formatId);
  if (entry === undefined) {
    throw new CanonicalJsonError(`unsupported durable format ${JSON.stringify(formatId)}`, {
      code: UNSUPPORTED_FORMAT_ERROR,
    });
  }
  if (!isReadableVersion(version, entry.readableVersions)) {
    throw new CanonicalJsonError(
      `unsupported version ${version} for format ${JSON.stringify(formatId)}; readable versions: [${entry.readableVersions.join(", ")}]`,
      { code: UNSUPPORTED_FORMAT_VERSION_ERROR },
    );
  }
}

export function assertEnvelopeSupported(envelope: {
  readonly format: string;
  readonly version: number;
}): void {
  assertFormatSupported(envelope.format, envelope.version);
}

export const FORMAT_DEFAULT_MAX_BYTES_BY_FORMAT: Readonly<Record<string, number>> = Object.freeze({
  "framework.event-envelope": FORMAT_DEFAULT_MAX_CANONICAL_BYTES.eventOutboxEnvelope,
  "framework.authority-provenance": FORMAT_DEFAULT_MAX_CANONICAL_BYTES.authorityProvenance,
  "framework.execution-scope-id": FORMAT_DEFAULT_MAX_CANONICAL_BYTES.executionScopeIdentitySource,
} as const);

export function getFormatDefaultMaxBytes(formatId: string): number | undefined {
  return Object.hasOwn(FORMAT_DEFAULT_MAX_BYTES_BY_FORMAT, formatId) ? FORMAT_DEFAULT_MAX_BYTES_BY_FORMAT[formatId] : undefined;
}

let validated = false;
export function ensureRegistryValid(): void {
  if (validated) return;
  validateRegistry();
  for (const entry of COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries) {
    if (!entry.readableVersions.includes(entry.formatVersion)) {
      throw new CanonicalJsonError(
        `readableVersions for ${entry.formatId} must include current formatVersion ${entry.formatVersion}`,
        { code: INVALID_ENVELOPE_ERROR },
      );
    }
  }
  validated = true;
}
