import { aiEnvFields } from '@monitorly/ai';
import { baseEnvSchema, z } from '@monitorly/config';

/** Schema only — importing this file has no side effects (tests build their own env from it). */
export const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters (see .env.example for a generator)'),
  JWT_EXPIRES_IN_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  /** Login/register attempts allowed per IP per 15 minutes. */
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(20),
  MAX_MONITORS_PER_USER: z.coerce.number().int().min(1).default(20),
  /** Set to the number of proxies in front of the API in production (for correct client IPs). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** AI interpretations allowed per user per hour (each one costs an OpenAI call). */
  AI_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
  ...aiEnvFields,
});

export type Env = z.output<typeof apiEnvSchema>;
