export interface TrustedClientIpConfig {
  trustedProxyIps: readonly string[]
  trustedProxyHops: number
}

export interface HttpRequestMetadata {
  /** The transport peer supplied by the HTTP runtime, never by request headers. */
  peerAddress?: string | null
  /** An authenticated runtime assertion that the transport peer is a configured proxy. */
  trustedProxy?: boolean
}

function normalizeIp(value: string): string {
  return value.trim().replace(/^\[|\]$/g, "").toLowerCase()
}

function isTrustedProxy(ip: string, allowlist: readonly string[]): boolean {
  const normalized = normalizeIp(ip)
  return allowlist.some((entry) => normalizeIp(entry) === normalized)
}

/** Uses forwarded identity only after the HTTP runtime authenticates the immediate peer. */
export function resolveTrustedClientIp(request: Request, config: TrustedClientIpConfig, metadata?: HttpRequestMetadata): string | null {
  const peerAddress = metadata?.peerAddress?.trim() || null
  const hops = config.trustedProxyHops
  if (!Number.isInteger(hops) || hops < 0 || config.trustedProxyIps.length === 0) return peerAddress

  const peerIsTrusted = metadata?.trustedProxy === true && peerAddress !== null && isTrustedProxy(peerAddress, config.trustedProxyIps)
  // A proxy assertion without the authenticated transport peer is not enough:
  // otherwise the final forwarded entry becomes an attacker-controlled peer.
  if (peerAddress === null || !peerIsTrusted) return peerAddress

  const forwarded = request.headers.get("x-forwarded-for")
    ?.split(",")
    .map(normalizeIp)
    .filter(Boolean) ?? []
  if (hops === 0) return peerAddress
  // The chain must contain exactly one client address plus the configured
  // proxy hops. Extra addresses can be attacker-supplied prefix entries.
  if (forwarded.length !== hops + 1) return null

  if (peerAddress !== null && !isTrustedProxy(peerAddress, config.trustedProxyIps)) return null
  if (!forwarded.slice(-hops).every((ip) => isTrustedProxy(ip, config.trustedProxyIps))) return null
  if (peerAddress !== null && forwarded.at(-1) !== normalizeIp(peerAddress)) return null
  return forwarded[forwarded.length - hops - 1] || null
}
