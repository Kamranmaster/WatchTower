import { afterAll, beforeAll, beforeEach } from 'vitest';
import { Monitor, User, connectDatabase, disconnectDatabase, mongoose, partitionFor, syncAllIndexes } from '@monitorly/database';
import { createSilentLogger } from '@monitorly/logger';

/** Own database so it never collides with the API tests. Requires `npm run infra:up` (replica set → transactions). */
const TEST_DB_URI =
  process.env.TEST_SCHEDULER_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_scheduler_test?directConnection=true';

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

let userId: mongoose.Types.ObjectId | undefined;

async function testUser() {
  if (!userId || !(await User.exists({ _id: userId }))) {
    const user = await User.create({ name: 'Sched', email: `sched-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x' });
    userId = user._id;
  }
  return userId;
}

export async function createMonitor(fields: Record<string, unknown> = {}) {
  const _id = new mongoose.Types.ObjectId();
  return Monitor.create({
    _id,
    userId: await testUser(),
    url: 'https://careers.example.com/jobs',
    instruction: 'new intern roles',
    checkIntervalMinutes: 30,
    status: 'active',
    partitionId: partitionFor(_id.toString()),
    nextCheckAt: new Date(Date.now() - 1000),
    ...fields,
  });
}

/** A controllable clock for lease tests. */
export function fakeClock(start = Date.now()) {
  let now = start;
  return {
    clock: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

export const ALL_PARTITIONS = Array.from({ length: 64 }, (_, i) => i);
