import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * SSRF protection for user-supplied URLs.
 *
 * Users can submit any URL, so without these checks they could make our servers
 * request internal services (databases, admin panels, cloud metadata at 169.254.169.254).
 *
 * Call `assertSafeUrl` when a monitor is saved AND again immediately before every
 * fetch and every redirect hop: DNS can change between those moments (DNS rebinding).
 */

export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError';
}

/** Resolves a hostname to every IP address it points at. Injectable for tests. */
export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Hostnames that are internal by convention, regardless of what they resolve to. */
const BLOCKED_HOSTNAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa)$/i;

/** Only standard web ports — blocks using monitors to probe arbitrary services. */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/** True only for globally routable unicast addresses. Everything else (private, loopback, link-local, CGNAT, reserved, multicast…) is rejected. */
export function isPublicIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let address = ipaddr.parse(ip);
  if (address.kind() === 'ipv6') {
    const v6 = address as ipaddr.IPv6;
    // ::ffff:10.0.0.1 is really 10.0.0.1
    if (v6.isIPv4MappedAddress()) address = v6.toIPv4Address();
  }
  return address.range() === 'unicast';
}

/**
 * Synchronous checks on the URL itself. Returns a normalised URL (fragment removed).
 * Throws UnsafeUrlError with a user-presentable message.
 */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError('Enter a full URL, including https://');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http:// and https:// URLs are supported');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('URLs containing a username or password are not allowed');
  }
  // WHATWG URL already normalises tricks like http://2130706433/ and http://0x7f.1/ to 127.0.0.1.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new UnsafeUrlError('The URL has no hostname');

  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new UnsafeUrlError('This address points to a private or internal network');
  } else {
    if (BLOCKED_HOSTNAME.test(host)) {
      throw new UnsafeUrlError('This address points to a private or internal network');
    }
    if (!host.includes('.')) {
      throw new UnsafeUrlError('Use a public domain name, such as example.com');
    }
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UnsafeUrlError('Only standard web ports (80, 443, 8080, 8443) are allowed');
  }

  url.hash = '';
  return url;
}

export interface SafeUrl {
  url: URL;
  /** The addresses the hostname resolved to at check time. Fetchers should connect to one of these. */
  addresses: string[];
}

/** Full check: URL rules + DNS resolution, rejecting if ANY resolved address is non-public. */
export async function assertSafeUrl(raw: string, options: { lookup?: LookupFn } = {}): Promise<SafeUrl> {
  const url = parsePublicUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) return { url, addresses: [host] };

  let addresses: string[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(host);
  } catch {
    throw new UnsafeUrlError(`Could not find a website at ${host}. Check the address.`);
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Could not find a website at ${host}. Check the address.`);
  }
  if (addresses.some((address) => !isPublicIp(address))) {
    throw new UnsafeUrlError('This address points to a private or internal network');
  }
  return { url, addresses };
}
