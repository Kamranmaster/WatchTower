/** Ports, URLs and environment shared by the Playwright config, the seed server and the tests. */
const apiPort = Number(process.env.E2E_API_PORT ?? 4100);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5180);
const seedPort = Number(process.env.E2E_SEED_PORT ?? 4199);

const webOrigin = `http://localhost:${webPort}`;
const mongoUri = process.env.E2E_MONGODB_URI ?? 'mongodb://localhost:27017/monitorly_e2e?directConnection=true';
const rabbitUrl = process.env.E2E_RABBITMQ_URL ?? 'amqp://monitorly:monitorly@localhost:5672';

export const E2E = {
  apiPort,
  webPort,
  seedPort,
  webOrigin,
  apiUrl: `http://localhost:${apiPort}`,
  // The seed server binds to 127.0.0.1 only (localhost can resolve to ::1 on Windows).
  seedUrl: `http://127.0.0.1:${seedPort}`,
  mongoUri,
  rabbitUrl,
  /**
   * For the API and the seed server. Everything the API needs is set here, so the tests don't
   * depend on your .env. AI is switched off: the tests never call (or pay for) a real AI
   * provider, and AI answers are faked in the browser where a test needs them.
   */
  serverEnv: {
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    API_PORT: String(apiPort),
    SEED_PORT: String(seedPort),
    WEB_ORIGIN: webOrigin,
    MONGODB_URI: mongoUri,
    RABBITMQ_URL: rabbitUrl,
    JWT_SECRET: 'e2e-only-secret-that-is-at-least-32-characters-long',
    BCRYPT_ROUNDS: '4',
    AUTH_RATE_LIMIT: '10000',
    AI_API_KEY: '',
    OPENAI_API_KEY: '',
    S3_ENDPOINT: process.env.E2E_S3_ENDPOINT ?? 'http://localhost:8333',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'monitorly-snapshots',
    S3_ACCESS_KEY_ID: 'monitorly',
    S3_SECRET_ACCESS_KEY: 'monitorly-secret',
    S3_FORCE_PATH_STYLE: 'true',
  } as Record<string, string>,
};
