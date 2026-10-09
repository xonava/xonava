export const VERSION_TAXONOMY_DOMAINS = [
  "framework-package",
  "definition",
  "policy",
  "policy-digest",
  "envelope-format",
  "payload-schema",
  "fingerprint",
  "canonicalization",
  "cursor-format",
  "database-migration",
  "entity-version",
] as const

export type VersionTaxonomyDomain = (typeof VERSION_TAXONOMY_DOMAINS)[number]

export const CANONICALIZATION_VERSION = "jcs-rfc8785-v1"

export const DIGEST_ALGORITHM_VERSION = "sha256-v1"

export const ENVELOPE_TIMESTAMP_PRECISION = "rfc3339-utc-milliseconds"

export const BINARY_JSON_ENCODING = "base64url-unpadded"

export const CANONICAL_SERIALIZATION_RULES = {
  unicodeNormalization: "none",
  duplicateObjectKeys: "reject",
  nonFiniteNumbers: "reject",
  loneSurrogates: "reject",
  arraysPreserveElementOrder: true,
  insignificantWhitespaceEmitted: false,
} as const

export const ENTITY_VERSION_MIN = 0

export const FINGERPRINT_DOMAIN_SEPARATORS = Object.freeze({
  idempotency: "framework:idempotency:v1:",
  outbox: "framework:outbox:v1:",
  cursorQuery: "framework:cursor-query:v1:",
} as const)
