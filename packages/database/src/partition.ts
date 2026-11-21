import { createHash } from 'node:crypto';

/** Logical partitions for scheduler ownership. Changing this reshuffles every monitor — pick once. */
export const TOTAL_PARTITIONS = 64;

export function partitionFor(id: string): number {
  const digest = createHash('sha1').update(id).digest();
  return digest.readUInt32BE(0) % TOTAL_PARTITIONS;
}
