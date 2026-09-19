import { ConfigurationError } from "./errors.js"

export type PrincipalKind = "human" | "service" | "system" | "anonymous"

export interface Principal {
  readonly id: string
  readonly kind: PrincipalKind
  readonly authentication:
    | {
        readonly kind: "authenticated"
        readonly method: string
        readonly authenticatedAt: string
        readonly assuranceLevel?: string
        readonly sessionId?: string
      }
    | { readonly kind: "anonymous" }
}

export interface ExecutionIdentity {
  readonly actor: Principal
  readonly subject: Principal
}

const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/

export function isRfc3339UtcInstant(value: string): boolean {
  const match = RFC3339_UTC.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false

  // Date.parse normalizes invalid calendar dates (for example, February 31)
  // instead of rejecting them. Construct and round-trip the individual UTC
  // fields so authorization expiry and authentication timestamps are facts,
  // not normalized approximations.
  const fraction = match[7] ?? ""
  const milliseconds = Number(`${fraction.slice(0, 3).padEnd(3, "0")}`)
  const candidate = new Date(0)
  candidate.setUTCFullYear(year, month - 1, day)
  candidate.setUTCHours(hour, minute, second, milliseconds)
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day &&
    candidate.getUTCHours() === hour &&
    candidate.getUTCMinutes() === minute &&
    candidate.getUTCSeconds() === second
}

export function assertPrincipal(principal: Principal): void {
  if (!principal || typeof principal !== "object" || !(["human", "service", "system", "anonymous"] as const).includes(principal.kind)) {
    throw new ConfigurationError("principal.kind is invalid")
  }
  if (typeof principal.id !== "string" || principal.id.trim().length === 0) throw new ConfigurationError("principal.id must be non-empty")
  if (!principal.authentication || typeof principal.authentication !== "object") throw new ConfigurationError("principal.authentication is invalid")
  if (principal.kind === "anonymous") {
    if (principal.authentication.kind !== "anonymous") {
      throw new ConfigurationError("anonymous principal must use anonymous authentication")
    }
    return
  }
  if (principal.authentication.kind !== "authenticated") {
    throw new ConfigurationError("non-anonymous principal must be authenticated")
  }
  if (typeof principal.authentication.method !== "string" || principal.authentication.method.trim().length === 0) {
    throw new ConfigurationError("authentication.method must be non-empty")
  }
  if (typeof principal.authentication.authenticatedAt !== "string" || !isRfc3339UtcInstant(principal.authentication.authenticatedAt)) {
    throw new ConfigurationError("authentication.authenticatedAt must be an RFC 3339 UTC instant")
  }
}

export function createAnonymousPrincipal(id = "anonymous"): Principal {
  const principal: Principal = { id, kind: "anonymous", authentication: { kind: "anonymous" } }
  assertPrincipal(principal)
  return Object.freeze({ ...principal, authentication: Object.freeze(principal.authentication) })
}
