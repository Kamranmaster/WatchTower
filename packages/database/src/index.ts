export { connectDatabase, disconnectDatabase, pingDatabase, syncAllIndexes } from './connection';
export { TOTAL_PARTITIONS, partitionFor } from './partition';

/** MongoDB E11000: a unique index rejected the write. */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
export * from './models';
export { default as mongoose } from 'mongoose';
