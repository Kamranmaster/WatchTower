import { z } from 'zod';
import { USER_AGENT } from './http-fetch';

/** Env fields shared by the fetch workers. Spread into a worker's env schema. */
export const fetchEnvFields = {
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  FETCH_MAX_BYTES: z.coerce.number().int().min(10_000).default(5 * 1024 * 1024),
  FETCH_USER_AGENT: z.string().trim().min(1).default(USER_AGENT),
  RESPECT_ROBOTS_TXT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Consecutive failed checks before a monitor is set to "error" and stops being scheduled. */
  MONITOR_ERROR_THRESHOLD: z.coerce.number().int().min(1).default(5),
};
