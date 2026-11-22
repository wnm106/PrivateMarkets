/**
 * Which addresses a client's MCP server may have.
 *
 * The chat route connects to an address an administrator typed in, from inside
 * our network. A careless or hostile address could otherwise point it at our
 * own services (metadata endpoints, the database, localhost). So a server must
 * be https on the public internet. Plain http and private addresses are allowed
 * only when ASSISTANT_MCP_ALLOW_PRIVATE=true, for local development.
 *
 * `checkServerUrl` checks the text of the address. `assertPublicHost` also
 * resolves the host name and refuses one that resolves to a private address;
 * the client runs it before every request it sends.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicAddress } from '../lib/public-address';

export function privateAddressesAllowed(): boolean {
  return process.env.ASSISTANT_MCP_ALLOW_PRIVATE === 'true';
}

/**
 * True for any IP address that is not a host on the public internet: loopback,
 * private, link-local, carrier-grade NAT, multicast, reserved, and IPv4 carried
 * inside IPv6 (mapped, NAT64, 6to4, Teredo) however it is written. The URL
 * parser rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1], so both forms must be
 * read the same way. False for text that is not an IP address.
 */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.replace(/^\[|\]$/g, '').split('%')[0];
  return isIP(address) !== 0 && !isPublicAddress(address);
}

const PRIVATE_NAMES = /(^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|^metadata\.google\.internal$)/i;

/** Returns why an address cannot be used, or null when it can. */
export function checkServerUrl(raw: string, allowPrivate = privateAddressesAllowed()): string | null {
  let url: URL;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return 'Enter a full address, starting with https://.';
  }
  if (url.username || url.password) return 'Put the credential in the sign-in fields, not in the address.';
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    return 'The address must start with https://.';
  }
  if (!allowPrivate) {
    const host = url.hostname;
    if (PRIVATE_NAMES.test(host) || (isIP(host.replace(/^\[|\]$/g, '')) && isPrivateAddress(host))) {
      return 'The address must be on the public internet, not a private or local network.';
    }
  }
  return null;
}

/**
 * Throws when the address's host resolves to a private address. Returns the
 * addresses it checked, so the connection can be made to them and no other
 * (pinnedFetch); empty when private addresses are allowed.
 */
export async function assertPublicHost(
  raw: string,
  allowPrivate = privateAddressesAllowed(),
  resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
): Promise<string[]> {
  const problem = checkServerUrl(raw, allowPrivate);
  if (problem) throw new Error(problem);
  if (allowPrivate) return [];
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (!addresses.length || addresses.some((address) => isPrivateAddress(address))) {
    throw new Error('The server address resolves to a private network, which the assistant may not reach.');
  }
  return addresses;
}
