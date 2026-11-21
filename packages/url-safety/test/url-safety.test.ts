import { describe, expect, it } from 'vitest';
import { UnsafeUrlError, assertSafeUrl, isPublicIp, parsePublicUrl } from '../src/index';

const fakeDns: Record<string, string[]> = {
  'jobs.example.com': ['93.184.215.14'],
  'v6.example.com': ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
  'rebind.example.com': ['93.184.215.14', '10.0.0.5'], // one public + one private → reject
  'metadata.example.com': ['169.254.169.254'],
};
const lookup = async (host: string) => {
  const result = fakeDns[host];
  if (!result) throw new Error('ENOTFOUND');
  return result;
};

describe('isPublicIp', () => {
  it.each(['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111'])('allows public %s', (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1', // loopback
    '10.1.2.3', // private
    '172.16.0.1', // private
    '192.168.1.1', // private
    '169.254.169.254', // link-local / cloud metadata
    '100.100.100.200', // CGNAT / Alibaba metadata
    '0.0.0.0', // unspecified
    '224.0.0.1', // multicast
    '::1', // IPv6 loopback
    'fd00::1', // IPv6 unique local
    'fe80::1', // IPv6 link-local
    '::ffff:10.0.0.1', // IPv4-mapped private
    'not-an-ip',
  ])('rejects %s', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });
});

describe('parsePublicUrl', () => {
  it('accepts and normalises a normal https URL', () => {
    expect(parsePublicUrl('  https://careers.example.com/jobs?team=eng#open  ').href).toBe(
      'https://careers.example.com/jobs?team=eng',
    );
  });

  it.each([
    ['ftp://example.com/file', /http/],
    ['file:///etc/passwd', /http/],
    ['javascript:alert(1)', /http/],
    ['not a url', /full URL/],
    ['https://user:pass@example.com', /username or password/],
    ['https://example.com:22/', /standard web ports/],
    ['http://localhost:8080', /private or internal/],
    ['http://api.localhost/', /private or internal/],
    ['http://printer.local/', /private or internal/],
    ['http://metadata.google.internal/', /private or internal/],
    ['http://127.0.0.1/', /private or internal/],
    ['http://2130706433/', /private or internal/], // decimal 127.0.0.1
    ['http://0x7f.1/', /private or internal/], // hex 127.0.0.1
    ['http://[::1]/', /private or internal/],
    ['http://169.254.169.254/latest/meta-data/', /private or internal/],
    ['http://intranet.corp.internal/', /private or internal/],
    ['http://fileserver/', /public domain/], // single-label names resolve via local DNS search domains
  ])('rejects %s', (raw, message) => {
    expect(() => parsePublicUrl(raw)).toThrowError(message);
  });
});

describe('assertSafeUrl', () => {
  it('resolves a public hostname', async () => {
    const { url, addresses } = await assertSafeUrl('https://jobs.example.com/careers', { lookup });
    expect(url.hostname).toBe('jobs.example.com');
    expect(addresses).toEqual(['93.184.215.14']);
  });

  it('accepts public IPv6', async () => {
    await expect(assertSafeUrl('https://v6.example.com', { lookup })).resolves.toBeTruthy();
  });

  it('rejects a hostname where any address is private', async () => {
    await expect(assertSafeUrl('https://rebind.example.com', { lookup })).rejects.toThrow(UnsafeUrlError);
  });

  it('rejects a hostname resolving to cloud metadata', async () => {
    await expect(assertSafeUrl('https://metadata.example.com', { lookup })).rejects.toThrow(/private or internal/);
  });

  it('rejects an unresolvable hostname', async () => {
    await expect(assertSafeUrl('https://nope.example.com', { lookup })).rejects.toThrow(/Could not find/);
  });
});
