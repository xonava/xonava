import { ConfigurationError } from "../domain/errors"

export type EntityVersion = number

export function isEntityVersion(value: unknown): value is EntityVersion {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function assertEntityVersion(value: unknown): asserts value is EntityVersion {
  if (!isEntityVersion(value)) {
    throw new ConfigurationError("Entity version must be a non-negative safe integer.")
  }
}

export function assertEntityVersionCanIncrement(value: unknown): asserts value is EntityVersion {
  assertEntityVersion(value)
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new ConfigurationError("Entity version cannot be incremented beyond the maximum safe integer.")
  }
}
