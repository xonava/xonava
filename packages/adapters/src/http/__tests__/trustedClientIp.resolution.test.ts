import { describe, expect, it } from "vitest"
import { resolveTrustedClientIp, type HttpRequestMetadata } from "../trustedClientIp"

function request(xff?: string): Request {
  return new Request("https://example.test/", xff === undefined ? {} : { headers: { "x-forwarded-for": xff } })
}

const trusted: HttpRequestMetadata = { peerAddress: "10.0.0.1", trustedProxy: true }
const config = { trustedProxyIps: ["10.0.0.1", "10.0.0.2"], trustedProxyHops: 1 }

describe("resolveTrustedClientIp", () => {
  describe("peer address handling", () => {
    it("trims the transport peer and treats blank or missing peers as null", () => {
      expect(resolveTrustedClientIp(request(), { ...config, trustedProxyIps: [] }, { peerAddress: "  203.0.113.5  " })).toBe("203.0.113.5")
      expect(resolveTrustedClientIp(request(), config, { peerAddress: "   " })).toBeNull()
      expect(resolveTrustedClientIp(request(), config, { peerAddress: null })).toBeNull()
      expect(resolveTrustedClientIp(request(), config)).toBeNull()
    })

    it("returns the trimmed untrusted peer and ignores forwarded headers from it", () => {
      expect(resolveTrustedClientIp(request("1.1.1.1, 10.0.0.1"), config, { peerAddress: " 192.0.2.9 ", trustedProxy: true })).toBe("192.0.2.9")
      expect(resolveTrustedClientIp(request("1.1.1.1, 192.0.2.9"), config, { peerAddress: "192.0.2.9", trustedProxy: true })).toBe("192.0.2.9")
    })

    it("does not trust a peer in the allowlist unless the runtime asserts trustedProxy === true", () => {
      for (const trustedProxy of [false, 1 as never, "true" as never]) {
        expect(resolveTrustedClientIp(request("1.1.1.1, 10.0.0.1"), config, { peerAddress: "10.0.0.1", trustedProxy })).toBe("10.0.0.1")
      }
      expect(resolveTrustedClientIp(request("1.1.1.1, 10.0.0.1"), config, { peerAddress: "10.0.0.1" })).toBe("10.0.0.1")
    })

    it("returns null for a trusted proxy assertion without a transport peer", () => {
      expect(resolveTrustedClientIp(request("1.1.1.1, 10.0.0.1"), config, { peerAddress: null, trustedProxy: true })).toBeNull()
      expect(resolveTrustedClientIp(request("1.1.1.1, 10.0.0.1"), config, { trustedProxy: true })).toBeNull()
      expect(resolveTrustedClientIp(request("10.0.0.1"), config, { peerAddress: " ", trustedProxy: true })).toBeNull()
    })
  })

  describe("configuration guards", () => {
    it("returns the peer for invalid hop counts even when the peer is a trusted proxy", () => {
      for (const trustedProxyHops of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
        expect(resolveTrustedClientIp(request("1.1.1.1, 10.0.0.1"), { ...config, trustedProxyHops }, trusted)).toBe("10.0.0.1")
      }
      expect(resolveTrustedClientIp(request("1.1.1.1"), { ...config, trustedProxyHops: -1 }, trusted)).toBe("10.0.0.1")
      expect(resolveTrustedClientIp(request("1.1.1.1"), { ...config, trustedProxyHops: Number.NaN }, trusted)).toBe("10.0.0.1")
    })

    it("returns the peer when the proxy allowlist is empty", () => {
      expect(resolveTrustedClientIp(request("1.1.1.1, 10.0.0.1"), { trustedProxyIps: [], trustedProxyHops: 1 }, trusted)).toBe("10.0.0.1")
    })

    it("returns the peer for zero hops regardless of the forwarded header", () => {
      expect(resolveTrustedClientIp(request("9.9.9.9"), { ...config, trustedProxyHops: 0 }, trusted)).toBe("10.0.0.1")
      expect(resolveTrustedClientIp(request(), { ...config, trustedProxyHops: 0 }, trusted)).toBe("10.0.0.1")
      expect(resolveTrustedClientIp(request("9.9.9.9, 8.8.8.8"), { ...config, trustedProxyHops: 0 }, trusted)).toBe("10.0.0.1")
    })
  })

  describe("forwarded chain", () => {
    it("returns the client for exactly one hop", () => {
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.1"), config, trusted)).toBe("203.0.113.7")
    })

    it("fails closed when the header is missing or empty", () => {
      expect(resolveTrustedClientIp(request(), config, trusted)).toBeNull()
      expect(resolveTrustedClientIp(request(""), config, trusted)).toBeNull()
      expect(resolveTrustedClientIp(request(" , "), config, trusted)).toBeNull()
    })

    it("ignores empty entries when counting the chain", () => {
      expect(resolveTrustedClientIp(request("203.0.113.7,, 10.0.0.1,"), config, trusted)).toBe("203.0.113.7")
      expect(resolveTrustedClientIp(request(", 203.0.113.7 , ,10.0.0.1"), config, trusted)).toBe("203.0.113.7")
    })

    it("rejects chains with too few or too many addresses", () => {
      expect(resolveTrustedClientIp(request("10.0.0.1"), config, trusted)).toBeNull()
      expect(resolveTrustedClientIp(request("6.6.6.6, 203.0.113.7, 10.0.0.1"), config, trusted)).toBeNull()
      const two = { ...config, trustedProxyHops: 2 }
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.1"), two, trusted)).toBeNull()
      expect(resolveTrustedClientIp(request("6.6.6.6, 203.0.113.7, 10.0.0.2, 10.0.0.1"), two, trusted)).toBeNull()
    })

    it("requires the last forwarded entry to equal the authenticated peer", () => {
      // 10.0.0.2 is a trusted proxy too, but it is not the connected peer.
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.2"), config, trusted)).toBeNull()
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.2"), config, { peerAddress: "10.0.0.2", trustedProxy: true })).toBe("203.0.113.7")
    })

    it("requires every proxy hop, not just one, to be trusted", () => {
      const two = { ...config, trustedProxyHops: 2 }
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.2, 10.0.0.1"), two, trusted)).toBe("203.0.113.7")
      // untrusted middle hop (attacker-controlled): only the last entry is the real peer
      expect(resolveTrustedClientIp(request("203.0.113.7, 198.51.100.1, 10.0.0.1"), two, trusted)).toBeNull()
      // untrusted first proxy hop while the last is the peer
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.2, 10.0.0.1"), two, { peerAddress: "10.0.0.1", trustedProxy: true })).toBe("203.0.113.7")
    })

    it("does not accept a spoofed client that is itself the last hop", () => {
      const three = { trustedProxyIps: ["10.0.0.1", "10.0.0.2", "10.0.0.3"], trustedProxyHops: 3 }
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.3, 10.0.0.2, 10.0.0.1"), three, trusted)).toBe("203.0.113.7")
      expect(resolveTrustedClientIp(request("203.0.113.7, 6.6.6.6, 10.0.0.2, 10.0.0.1"), three, trusted)).toBeNull()
    })
  })

  describe("address normalisation", () => {
    it("compares IPv6 case-insensitively and ignores surrounding whitespace and brackets", () => {
      const v6 = { trustedProxyIps: ["2001:DB8::1"], trustedProxyHops: 1 }
      const peer: HttpRequestMetadata = { peerAddress: "2001:db8::1", trustedProxy: true }
      expect(resolveTrustedClientIp(request("2001:DB8::99, 2001:DB8::1"), v6, peer)).toBe("2001:db8::99")
      expect(resolveTrustedClientIp(request("[2001:db8::99], [2001:db8::1]"), v6, peer)).toBe("2001:db8::99")
      expect(resolveTrustedClientIp(request("  [2001:DB8::99]  ,  [2001:DB8::1]  "), { trustedProxyIps: [" [2001:db8::1] "], trustedProxyHops: 1 }, { peerAddress: " [2001:DB8::1] ", trustedProxy: true })).toBe("2001:db8::99")
    })

    it("removes only a leading opening and a trailing closing bracket", () => {
      const meta = (ip: string): HttpRequestMetadata => ({ peerAddress: ip, trustedProxy: true })
      // brackets in the middle are not stripped, so these entries differ from the plain address
      expect(resolveTrustedClientIp(request("203.0.113.7, a[b"), { trustedProxyIps: ["ab"], trustedProxyHops: 1 }, meta("ab"))).toBeNull()
      expect(resolveTrustedClientIp(request("203.0.113.7, a]b"), { trustedProxyIps: ["ab"], trustedProxyHops: 1 }, meta("ab"))).toBeNull()
      expect(resolveTrustedClientIp(request("203.0.113.7, a[b"), { trustedProxyIps: ["ab", "a[b"], trustedProxyHops: 1 }, meta("ab"))).toBeNull()
      expect(resolveTrustedClientIp(request("203.0.113.7, a]b"), { trustedProxyIps: ["ab", "a]b"], trustedProxyHops: 1 }, meta("ab"))).toBeNull()
      // a trailing opening bracket and a leading closing bracket are kept
      expect(resolveTrustedClientIp(request("203.0.113.7, ab["), { trustedProxyIps: ["ab"], trustedProxyHops: 1 }, meta("ab"))).toBeNull()
      expect(resolveTrustedClientIp(request("203.0.113.7, ]ab"), { trustedProxyIps: ["ab"], trustedProxyHops: 1 }, meta("ab"))).toBeNull()
    })

    it("strips each outer bracket only once per side", () => {
      const cfg = { trustedProxyIps: ["::1"], trustedProxyHops: 1 }
      expect(resolveTrustedClientIp(request("203.0.113.7, [::1]"), cfg, { peerAddress: "::1", trustedProxy: true })).toBe("203.0.113.7")
      expect(resolveTrustedClientIp(request("203.0.113.7, [[::1]]"), cfg, { peerAddress: "::1", trustedProxy: true })).toBeNull()
    })

    it("matches exact addresses only: no CIDR ranges and no IPv4-mapped IPv6 equivalence", () => {
      const cidr = { trustedProxyIps: ["10.0.0.0/8"], trustedProxyHops: 1 }
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.1"), cidr, trusted)).toBe("10.0.0.1")
      const mapped = { trustedProxyIps: ["::ffff:10.0.0.1"], trustedProxyHops: 1 }
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.1"), mapped, trusted)).toBe("10.0.0.1")
      expect(resolveTrustedClientIp(request("203.0.113.7, ::ffff:10.0.0.1"), mapped, { peerAddress: "::FFFF:10.0.0.1", trustedProxy: true })).toBe("203.0.113.7")
      expect(resolveTrustedClientIp(request("203.0.113.7, 10.0.0.1"), { trustedProxyIps: ["10.0.0.10"], trustedProxyHops: 1 }, trusted)).toBe("10.0.0.1")
    })
  })
})
