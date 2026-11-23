/**
 * Whether an IP address is a host on the public internet.
 *
 * One answer for every place that connects to an address a person typed: the
 * assistant's MCP connections (external/url-guard.ts) and the worker's feed
 * connectors (packages/worker/src/connectors.ts). Two guards of different
 * strength is how an address gets past one of them, so both use this.
 *
 * Written as plain arithmetic, not node:net BlockList, so it also runs where
 * the web app is deployed.
 */

import { isIP } from 'node:net';

type Cidr = [network: number, prefix: number];

function v4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function cidr(text: string, prefix: number): Cidr {
  return [v4(text) as number, prefix];
}

function inV4(address: number, [network, prefix]: Cidr): boolean {
  if (prefix === 0) return true;
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(network / size);
}

/** IPv4 that is not a host on the public internet. */
const NOT_PUBLIC_V4: Cidr[] = [
  cidr('0.0.0.0', 8), // this network
  cidr('10.0.0.0', 8), // private
  cidr('100.64.0.0', 10), // shared by carriers (CGNAT)
  cidr('127.0.0.0', 8), // loopback
  cidr('169.254.0.0', 16), // link-local, where cloud metadata services live
  cidr('172.16.0.0', 12), // private
  cidr('192.0.0.0', 24), // protocol assignments
  cidr('192.0.2.0', 24), // documentation
  cidr('192.88.99.0', 24), // 6to4 relays
  cidr('192.168.0.0', 16), // private
  cidr('198.18.0.0', 15), // benchmarking
  cidr('198.51.100.0', 24), // documentation
  cidr('203.0.113.0', 24), // documentation
  cidr('224.0.0.0', 4), // multicast
  cidr('240.0.0.0', 4), // reserved, and broadcast
];

function publicV4(address: number): boolean {
  return !NOT_PUBLIC_V4.some((range) => inV4(address, range));
}

/** The eight 16-bit groups of an IPv6 address that isIP has already accepted. */
function groupsOf(address: string): number[] {
  // A dotted tail (::ffff:1.2.3.4) is the last two groups.
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted
    ? `${dotted[1]}${((Number(dotted[2]) << 8) | Number(dotted[3])).toString(16)}:${((Number(dotted[4]) << 8) | Number(dotted[5])).toString(16)}`
    : address;
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // "::" stands for as many zero groups as it takes to make eight.
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(zeros).fill('0'), ...right].map((group) => parseInt(group, 16));
}

function v4Of(high: number, low: number): number {
  return high * 65536 + low;
}

/**
 * The IPv4 addresses an IPv6 address carries inside it, or null when it carries
 * none. A packet sent to one of these forms is delivered to the IPv4 address
 * inside, so the address is only as public as that is. However the address is
 * written (::ffff:127.0.0.1 or ::ffff:7f00:1), the groups are the same.
 */
function embeddedV4(groups: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h] = groups;
  // ::a.b.c.d, the old IPv4-compatible form. :: and ::1 are in it too, as 0.0.0.0 and 0.0.0.1.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return [v4Of(g, h)];
  // ::ffff:a.b.c.d, IPv4-mapped.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return [v4Of(g, h)];
  // 64:ff9b::a.b.c.d, NAT64. A network with only IPv6 reaches IPv4 hosts through it.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return [v4Of(g, h)];
  // 2002:AABB:CCDD::/48, 6to4.
  if (a === 0x2002) return [v4Of(b, c)];
  // 2001:0:SERVER:..:CLIENT, Teredo. The client's address is stored with every bit flipped.
  if (a === 0x2001 && b === 0) return [v4Of(c, d), v4Of(g ^ 0xffff, h ^ 0xffff)];
  return null;
}

/** Whether the first `prefix` bits of two group lists agree. */
function inV6(groups: number[], network: number[], prefix: number): boolean {
  for (let i = 0; i < 8 && prefix > 0; i += 1, prefix -= 16) {
    const bits = Math.min(16, prefix);
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if ((groups[i] & mask) !== (network[i] & mask)) return false;
  }
  return true;
}

/** Global unicast that is set aside for something other than hosts. */
const NOT_PUBLIC_V6: Array<[string, number]> = [
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation
];

/** Whether an IP address is a host on the public internet. Anything that is not an IP address is not. */
export function isPublicAddress(address: string): boolean {
  // Brackets come from a URL's hostname. A zone (fe80::1%eth0) names an interface, not a different address.
  const text = String(address || '').replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const family = isIP(text);
  if (family === 4) {
    const value = v4(text);
    return value !== null && publicV4(value);
  }
  if (family !== 6) return false;
  const groups = groupsOf(text);
  const inside = embeddedV4(groups);
  if (inside) return inside.every(publicV4);
  // The only IPv6 that can be a public host is global unicast, 2000::/3. Everything
  // outside it is refused without being listed: ::1, fc00::/7, fe80::/10, ff00::/8.
  if (!inV6(groups, groupsOf('2000::'), 3)) return false;
  return !NOT_PUBLIC_V6.some(([network, prefix]) => inV6(groups, groupsOf(network), prefix));
}
