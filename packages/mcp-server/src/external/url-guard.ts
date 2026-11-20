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

export function privateAddressesAllowed(): boolean {
  return process.env.ASSISTANT_MCP_ALLOW_PRIVATE === 'true';
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = ipv4Parts(mapped ? mapped[1] : address);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    return (
      address === '::' || address === '::1' ||
      address.startsWith('fc') || address.startsWith('fd') ||
      address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb') ||
      address.startsWith('ff')
    );
  }
  return false;
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

/** Throws when the address's host resolves to a private address. */
export async function assertPublicHost(raw: string, allowPrivate = privateAddressesAllowed()): Promise<void> {
  const problem = checkServerUrl(raw, allowPrivate);
  if (problem) throw new Error(problem);
  if (allowPrivate) return;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('The server address resolves to a private network, which the assistant may not reach.');
  }
}
