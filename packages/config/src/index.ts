import { existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Walks up from the current directory to find the monorepo's .env file. */
function findEnvFile(start = process.cwd()): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const envFile = findEnvFile();
if (envFile) dotenv.config({ path: envFile, quiet: true });

/** Variables every service needs. Services extend this with their own requirements. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  RABBITMQ_URL: z.string().min(1, 'RABBITMQ_URL is required'),
});

/** Validates process.env against a schema; prints every problem and exits if invalid. */
export function loadEnv<S extends z.ZodType>(schema: S): z.output<S> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    console.error(
      `Invalid environment configuration${envFile ? ` (loaded ${envFile})` : ' (no .env file found)'}:\n${problems}`,
    );
    process.exit(1);
  }
  return result.data;
}

export { z };
