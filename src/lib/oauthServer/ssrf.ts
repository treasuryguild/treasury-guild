// SSRF guard for the one server-side fetch of a caller-chosen URL: a Client ID
// Metadata Document (the client_id is attacker-controlled).
import "server-only";

import { promises as dns } from "node:dns";
import net from "node:net";

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast / reserved
  );
}

/**
 * The eight 16-bit groups of an IPv6 address, whatever its spelling ("::"
 * anywhere, leading zeros, a dotted IPv4 tail); null when it is not one.
 */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split("%")[0]!;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function embeddedIPv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Works on the address's groups, not its text: `URL.hostname` spells a
 * v4-mapped address in hex ("::ffff:7f00:1"), and an address that carries an
 * IPv4 one is as private as that one.
 */
export function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if ((g0 & 0xfe00) === 0xfc00) return true; // ULA
  if ((g0 & 0xff80) === 0xfe80) return true; // link-local, site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // "::" and "::1" fall under v4-compatible: 0.0.0.0 and 0.0.0.1 are private.
    if (g5 === 0 || g5 === 0xffff) return isPrivateIPv4(embeddedIPv4(g6, g7)); // v4-compatible, v4-mapped
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 1) return true; // local-use NAT64
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIPv4(embeddedIPv4(g6, g7)); // NAT64
  }
  if (g0 === 0x2002) return isPrivateIPv4(embeddedIPv4(g1, g2)); // 6to4
  return false;
}

/** Unknown or unparseable input counts as private: fail closed. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

/** The host is, or points at, a private address: a verdict, not a transient failure. */
export class SsrfBlockedError extends Error {}

/**
 * Refuse a host that is, or resolves to, a private or loopback address.
 * Resolve-then-check: it blocks naming an internal host or the metadata
 * endpoint, not a DNS rebind between this check and the connect.
 */
export async function assertSafeHost(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw new SsrfBlockedError("Blocked: private or loopback address");
    return;
  }
  const records = await dns.lookup(bare, { all: true });
  if (records.length === 0) throw new Error("Blocked: DNS resolution failed");
  if (records.some((r) => isPrivateAddress(r.address))) {
    throw new SsrfBlockedError("Blocked: resolves to a private or loopback address");
  }
}
