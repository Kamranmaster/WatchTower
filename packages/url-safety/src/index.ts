import type { LookupAddress, LookupOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * SSRF protection for user-supplied URLs.
 *
 * Users can submit any URL, so without these checks they could make our servers
 * request internal services (databases, admin panels, cloud metadata at 169.254.169.254).
 *
 * - `assertSafeUrl` when a monitor is saved (friendly error for the user).
 * - `parsePublicUrl` on every URL and every redirect hop before fetching.
 * - `createSafeLookup` as the connection's DNS lookup, so the address actually connected to is
 *   the one that was checked (defeats DNS rebinding).
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
const ALLOWED_PORTS: ReadonlySet<string> = new Set(['', '80', '443', '8080', '8443']);

/**
 * What a URL may point at. Production always uses the defaults; overrides exist only so tests
 * can reach a local test server (set in code, never from configuration).
 */
export interface UrlPolicy {
  /** Ports as they appear in URL.port ('' = the scheme's default). */
  allowedPorts?: ReadonlySet<string>;
  isAllowedAddress?: (ip: string) => boolean;
  lookup?: LookupFn;
}

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
export function parsePublicUrl(raw: string, policy: UrlPolicy = {}): URL {
  const isAllowedAddress = policy.isAllowedAddress ?? isPublicIp;
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
    if (!isAllowedAddress(host)) throw new UnsafeUrlError('This address points to a private or internal network');
  } else {
    if (BLOCKED_HOSTNAME.test(host)) {
      throw new UnsafeUrlError('This address points to a private or internal network');
    }
    if (!host.includes('.')) {
      throw new UnsafeUrlError('Use a public domain name, such as example.com');
    }
  }

  if (!(policy.allowedPorts ?? ALLOWED_PORTS).has(url.port)) {
    throw new UnsafeUrlError('Only standard web ports (80, 443, 8080, 8443) are allowed');
  }

  url.hash = '';
  return url;
}

export interface SafeUrl {
  url: URL;
  /** The addresses the hostname resolved to at check time. */
  addresses: string[];
}

/** Full check: URL rules + DNS resolution, rejecting if ANY resolved address is non-public. */
export async function assertSafeUrl(
  raw: string,
  options: { lookup?: LookupFn; policy?: UrlPolicy } = {},
): Promise<SafeUrl> {
  const policy = options.policy ?? {};
  const isAllowedAddress = policy.isAllowedAddress ?? isPublicIp;
  const url = parsePublicUrl(raw, policy);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) return { url, addresses: [host] };

  let addresses: string[];
  try {
    addresses = await (options.lookup ?? policy.lookup ?? defaultLookup)(host);
  } catch {
    throw new UnsafeUrlError(`Could not find a website at ${host}. Check the address.`);
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Could not find a website at ${host}. Check the address.`);
  }
  if (addresses.some((address) => !isAllowedAddress(address))) {
    throw new UnsafeUrlError('This address points to a private or internal network');
  }
  return { url, addresses };
}

/** Error code set on lookup failures caused by a non-public address, so callers can recognise them. */
export const UNSAFE_ADDRESS_CODE = 'EUNSAFEADDRESS';

type NodeLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export type SafeLookup = (
  hostname: string,
  options: LookupOptions | number | NodeLookupCallback,
  callback?: NodeLookupCallback,
) => void;

/**
 * A drop-in replacement for dns.lookup, for http(s).Agent / net.connect `lookup` options.
 *
 * This is the check that actually protects the connection: it runs at connect time and the
 * socket connects to exactly the address it approved, so a hostname can't pass validation and
 * then re-resolve to an internal address (DNS rebinding). Rejects if ANY resolved address is
 * not allowed. (Node doesn't call lookup for IP-literal hosts; parsePublicUrl covers those.)
 */
export function createSafeLookup(policy: UrlPolicy = {}): SafeLookup {
  const resolve = policy.lookup ?? defaultLookup;
  const isAllowedAddress = policy.isAllowedAddress ?? isPublicIp;

  return (hostname, options, callback) => {
    const cb = (typeof options === 'function' ? options : callback)!;
    const opts: LookupOptions = typeof options === 'object' && options !== null ? options : {};

    resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          throw Object.assign(new Error(`No addresses found for ${hostname}`), { code: 'ENOTFOUND' });
        }
        if (addresses.some((address) => !isAllowedAddress(address))) {
          throw Object.assign(new UnsafeUrlError(`${hostname} resolves to a private or internal address`), {
            code: UNSAFE_ADDRESS_CODE,
          });
        }
        const entries = addresses
          .map((address) => ({ address, family: net.isIP(address) }))
          .filter((entry) => !opts.family || entry.family === opts.family);
        if (entries.length === 0) {
          throw Object.assign(new Error(`No IPv${opts.family} address for ${hostname}`), { code: 'ENOTFOUND' });
        }
        if (opts.all) cb(null, entries);
        else cb(null, entries[0]!.address, entries[0]!.family);
      })
      .catch((err: NodeJS.ErrnoException) => cb(err, '', 0));
  };
}
