import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { connectDatabase, disconnectDatabase, mongoose, syncAllIndexes } from '@monitorly/database';
import { createSilentLogger } from '@monitorly/logger';
import type { MessageBus } from '@monitorly/messaging';
import { createApp, type AppDeps } from '../src/app';
import { apiEnvSchema } from '../src/env';

/** Separate database so tests never touch dev data. Requires `npm run infra:up`. */
const TEST_DB_URI =
  process.env.TEST_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_test?directConnection=true';

export const testEnv = apiEnvSchema.parse({
  NODE_ENV: 'test',
  MONGODB_URI: TEST_DB_URI,
  RABBITMQ_URL: 'amqp://unused-in-these-tests',
  JWT_SECRET: 'test-only-secret-that-is-at-least-32-characters',
  BCRYPT_ROUNDS: '4', // fast hashing in tests
  AUTH_RATE_LIMIT: '1000',
  MAX_MONITORS_PER_USER: '3',
  AI_RATE_LIMIT: '5',
  AI_API_KEY: '', // tests never call a real AI provider
  WEB_ORIGIN: 'http://localhost:5173',
});

/** Fake DNS so tests don't depend on the network. */
const fakeDns: Record<string, string[]> = {
  'careers.example.com': ['93.184.215.14'],
  'shop.example.com': ['93.184.215.15'],
  'sneaky.example.com': ['10.0.0.8'], // public-looking name, private address
};

export function buildApp(overrides: Partial<AppDeps> = {}): Express {
  return createApp({
    env: testEnv,
    logger: createSilentLogger(),
    bus: { isHealthy: true } as unknown as MessageBus,
    lookup: async (host) => {
      const addresses = fakeDns[host];
      if (!addresses) throw new Error('ENOTFOUND');
      return addresses;
    },
    ...overrides,
  });
}

/** Connects once per file and wipes every collection before each test. */
export function useTestDatabase(): void {
  beforeAll(async () => {
    await connectDatabase(TEST_DB_URI, createSilentLogger());
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

let counter = 0;

/** Registers a fresh user and returns a cookie-carrying agent logged in as them. */
export async function signedInAgent(app: Express, name = 'Test User') {
  const agent = request.agent(app);
  const email = `user${++counter}-${Date.now()}@example.com`;
  const res = await agent.post('/api/auth/register').send({ name, email, password: 'correct-horse-battery' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, user: res.body.user as { id: string; email: string } };
}
