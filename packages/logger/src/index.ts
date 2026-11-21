import { pino, type Logger } from 'pino';

export type { Logger };

/** A logger that discards everything — for tests. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}

/**
 * Creates a structured logger tagged with the service name.
 * Pretty output in development; JSON in production or when LOG_FORMAT=json.
 */
export function createLogger(service: string): Logger {
  const json = process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT === 'json';
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['password', 'passwordHash', 'token', '*.password', '*.passwordHash', 'req.headers.authorization', 'req.headers.cookie'],
      censor: '[redacted]',
    },
    transport: json
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service', messageFormat: '[{service}] {msg}' },
        },
  });
}
