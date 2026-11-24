import { isIPv4, isIPv6 } from "node:net";

/**
 * SSRF address policy. Returns true for any address an outbound fetch of a
 * user-supplied URL must not reach. Fails closed: anything that is not a
 * well-formed IP address is blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) return isBlockedV4(parseV4(ip));
  // Strip an IPv6 zone index ("fe80::1%en0"); scoped addresses are link-local anyway.
  const bare = ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip;
  if (isIPv6(bare)) return isBlockedV6(parseV6(bare));
  return true;
}

// [network, prefix length] — every range that is not globally routable unicast.
const BLOCKED_V4: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network", incl. 0.0.0.0
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

const BLOCKED_V4_NUM = BLOCKED_V4.map(([net, len]) => {
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { net: (parseV4(net) & mask) >>> 0, mask };
});

function parseV4(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

function isBlockedV4(addr: number): boolean {
  return BLOCKED_V4_NUM.some(({ net, mask }) => ((addr & mask) >>> 0) === net);
}

/** Parse a valid IPv6 string (already checked by isIPv6) into 8 16-bit groups. */
function parseV6(ip: string): number[] {
  let text = ip;
  // Rewrite a trailing dotted IPv4 ("::ffff:1.2.3.4") as two hex groups.
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseV4(last);
    text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const toGroups = (s: string) => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));
  const dbl = text.indexOf("::");
  if (dbl === -1) return toGroups(text);
  const head = toGroups(text.slice(0, dbl));
  const rest = toGroups(text.slice(dbl + 2));
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

function embeddedV4(hi: number, lo: number): number {
  return ((hi << 16) | lo) >>> 0;
}

function isBlockedV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const first80Zero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // ::ffff:0:0/96 IPv4-mapped — judge by the embedded IPv4.
  if (first80Zero && g5 === 0xffff) return isBlockedV4(embeddedV4(g6, g7));
  // ::/96 — unspecified, loopback and deprecated IPv4-compatible addresses.
  if (first80Zero && g5 === 0) return true;
  // 64:ff9b::/96 well-known NAT64 prefix — judge by the embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedV4(embeddedV4(g6, g7));
  }
  // 2002::/16 6to4 — the IPv4 address is in groups 1-2.
  if (g0 === 0x2002) return isBlockedV4(embeddedV4(g1, g2));

  // Only global unicast 2000::/3 may pass. This excludes ULA fc00::/7,
  // link-local fe80::/10, site-local fec0::/10, multicast ff00::/8, 100::/64
  // discard, 64:ff9b:1::/48 local-use NAT64, and anything else unassigned.
  if ((g0 & 0xe000) !== 0x2000) return true;
  // 2001::/23 IETF protocol assignments (incl. Teredo 2001::/32, benchmarking).
  if (g0 === 0x2001 && g1 < 0x200) return true;
  // 2001:db8::/32 and 3fff::/20 documentation.
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  if (g0 === 0x3fff && g1 < 0x1000) return true;
  return false;
}
