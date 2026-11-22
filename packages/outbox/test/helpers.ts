import { afterAll, beforeAll, beforeEach } from 'vitest';
import { connectDatabase, disconnectDatabase, mongoose, syncAllIndexes } from '@monitorly/database';
import { createSilentLogger } from '@monitorly/logger';

const TEST_DB_URI =
  process.env.TEST_OUTBOX_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_outbox_test?directConnection=true';

export const logger = createSilentLogger();

export function useTestDatabase(): void {
  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI, logger);
    await syncAllIndexes();
  });
  beforeEach(async () => {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await disconnectDatabase();
  });
}

export function fakeClock(start = Date.now()) {
  let now = start;
  return {
    clock: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
