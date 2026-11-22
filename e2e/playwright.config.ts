import { defineConfig, devices } from '@playwright/test';
import { E2E } from './support/env';

/**
 * Browser tests against the real app: the production web build, the real API, MongoDB and
 * RabbitMQ (`npm run infra:up` first). They run on their own ports and their own database,
 * so they never touch `npm run dev` or its data. The pipeline workers are not started: tests
 * create changes and alerts through the seed server (support/seed-server.ts) instead of
 * waiting for real websites to change.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './support/global-setup.ts',
  use: {
    baseURL: E2E.webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: [
    {
      name: 'seed',
      command: 'npx tsx support/seed-server.ts',
      url: `${E2E.seedUrl}/health`,
      env: E2E.serverEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      name: 'api',
      command: 'npx tsx ../services/api/src/index.ts',
      url: `${E2E.apiUrl}/health/ready`,
      env: E2E.serverEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      name: 'web',
      command: 'npm run build -w @monitorly/web && npm run preview -w @monitorly/web',
      url: E2E.webOrigin,
      env: { MONITORLY_API_URL: E2E.apiUrl, WEB_PORT: String(E2E.webPort) },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
