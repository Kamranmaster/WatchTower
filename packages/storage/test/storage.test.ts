import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MemoryObjectStore,
  S3ObjectStore,
  getCompressedText,
  monitorPrefix,
  putCompressedText,
  rawSnapshotKey,
  type ObjectStore,
} from '../src';

const html = '<html><body>' + '<li>Software Engineer Intern — Bangalore</li>'.repeat(200) + '</body></html>';

function contract(name: string, make: () => ObjectStore) {
  describe(name, () => {
    it('round-trips compressed text and compresses it', async () => {
      const store = make();
      const monitorId = randomUUID();
      const key = rawSnapshotKey(monitorId, 'run1');
      const { storedBytes } = await putCompressedText(store, key, html);
      expect(storedBytes).toBeLessThan(html.length / 5);
      expect(await getCompressedText(store, key)).toBe(html);
      await store.deletePrefix(monitorPrefix(monitorId));
    });

    it('deletes everything under a monitor prefix and nothing else', async () => {
      const store = make();
      const a = randomUUID();
      const b = randomUUID();
      await putCompressedText(store, rawSnapshotKey(a, 'r1'), 'one');
      await putCompressedText(store, rawSnapshotKey(a, 'r2'), 'two');
      await putCompressedText(store, rawSnapshotKey(b, 'r1'), 'other');

      expect(await store.deletePrefix(monitorPrefix(a))).toBe(2);
      await expect(store.get(rawSnapshotKey(a, 'r1'))).rejects.toThrow();
      expect(await getCompressedText(store, rawSnapshotKey(b, 'r1'))).toBe('other');
      await store.deletePrefix(monitorPrefix(b));
    });
  });
}

contract('MemoryObjectStore', () => new MemoryObjectStore());

// Runs against the local SeaweedFS from docker-compose (`npm run infra:up`).
contract(
  'S3ObjectStore (SeaweedFS)',
  () =>
    new S3ObjectStore('monitorly-snapshots', {
      endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:8333',
      region: 'us-east-1',
      accessKeyId: 'monitorly',
      secretAccessKey: 'monitorly-secret',
      forcePathStyle: true,
    }),
);
