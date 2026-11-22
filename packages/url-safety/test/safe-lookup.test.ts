import { describe, expect, it } from 'vitest';
import { UNSAFE_ADDRESS_CODE, UnsafeUrlError, createSafeLookup, parsePublicUrl } from '../src/index';

const resolver = (map: Record<string, string[]>) => async (host: string) => {
  const addresses = map[host];
  if (!addresses) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return addresses;
};

const call = (lookup: ReturnType<typeof createSafeLookup>, host: string, options: object = {}) =>
  new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
    lookup(host, options, (err, address, family) => resolve({ err, address, family })),
  );

describe('createSafeLookup (connect-time check)', () => {
  it('returns a public address', async () => {
    const lookup = createSafeLookup({ lookup: resolver({ 'shop.example.com': ['93.184.215.14'] }) });
    expect(await call(lookup, 'shop.example.com')).toEqual({ err: null, address: '93.184.215.14', family: 4 });
  });

  it('returns every address when asked for all (as Node does with autoSelectFamily)', async () => {
    const v6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';
    const lookup = createSafeLookup({ lookup: resolver({ 'shop.example.com': ['93.184.215.14', v6] }) });
    const { address } = await call(lookup, 'shop.example.com', { all: true });
    expect(address).toEqual([
      { address: '93.184.215.14', family: 4 },
      { address: v6, family: 6 },
    ]);
  });

  it('rejects when any address is private, even if another one is public (rebinding defence)', async () => {
    const lookup = createSafeLookup({ lookup: resolver({ 'rebind.example.com': ['93.184.215.14', '169.254.169.254'] }) });
    const { err } = await call(lookup, 'rebind.example.com');
    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(err?.code).toBe(UNSAFE_ADDRESS_CODE);
  });

  it('rejects IPv4-mapped IPv6 loopback', async () => {
    const lookup = createSafeLookup({ lookup: resolver({ 'mapped.example.com': ['::ffff:127.0.0.1'] }) });
    expect((await call(lookup, 'mapped.example.com')).err?.code).toBe(UNSAFE_ADDRESS_CODE);
  });

  it('passes DNS failures through', async () => {
    const lookup = createSafeLookup({ lookup: resolver({}) });
    expect((await call(lookup, 'nope.example.com')).err?.code).toBe('ENOTFOUND');
  });

  it('honours a requested address family', async () => {
    const lookup = createSafeLookup({ lookup: resolver({ 'v6.example.com': ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'] }) });
    expect((await call(lookup, 'v6.example.com', { family: 4 })).err?.code).toBe('ENOTFOUND');
  });
});

describe('UrlPolicy overrides (tests only)', () => {
  it('can allow a local test server, but the defaults stay strict', () => {
    expect(() => parsePublicUrl('http://127.0.0.1:5555/')).toThrow(UnsafeUrlError);
    const policy = { allowedPorts: new Set(['5555']), isAllowedAddress: (ip: string) => ip === '127.0.0.1' };
    expect(parsePublicUrl('http://127.0.0.1:5555/', policy).href).toBe('http://127.0.0.1:5555/');
    expect(() => parsePublicUrl('http://10.0.0.1:5555/', policy)).toThrow(UnsafeUrlError);
    expect(() => parsePublicUrl('http://127.0.0.1:6666/', policy)).toThrow(UnsafeUrlError);
  });
});
