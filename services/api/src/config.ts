import { loadEnv } from '@monitorly/config';
import { apiEnvSchema } from './env';

/** Validated environment. Importing this exits the process if configuration is invalid. */
export const env = loadEnv(apiEnvSchema);
export type { Env } from './env';
