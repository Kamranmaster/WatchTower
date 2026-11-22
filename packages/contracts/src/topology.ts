import type { z } from 'zod';
import { aiAnalyzeJobSchema, contentProcessedSchema, emailJobSchema, fetchCompletedSchema, fetchJobSchema } from './messages';

/**
 * RabbitMQ topology — the single source of truth for exchange, routing key and queue names.
 *
 * Each work queue <q> also gets:
 *   <q>.retry.<delay>  TTL queues that dead-letter back into <q> (retry with backoff)
 *   <q>.dead           final resting place once retries are exhausted (DLQ)
 */
export const EXCHANGES = {
  monitor: 'monitor.events',
  notification: 'notification.events',
  deadLetter: 'dead.letter',
} as const;

export interface Route<S extends z.ZodType = z.ZodType> {
  exchange: string;
  routingKey: string;
  schema: S;
}

function route<S extends z.ZodType>(exchange: string, routingKey: string, schema: S): Route<S> {
  return { exchange, routingKey, schema };
}

/** Where producers publish. The schema is enforced on publish and on consume. */
export const ROUTES = {
  fetchHttp: route(EXCHANGES.monitor, 'fetch.http', fetchJobSchema),
  fetchBrowser: route(EXCHANGES.monitor, 'fetch.browser', fetchJobSchema),
  fetchCompleted: route(EXCHANGES.monitor, 'fetch.completed', fetchCompletedSchema),
  contentProcessed: route(EXCHANGES.monitor, 'content.processed', contentProcessedSchema),
  aiAnalyze: route(EXCHANGES.monitor, 'ai.analyze', aiAnalyzeJobSchema),
  notifyEmail: route(EXCHANGES.notification, 'notify.email', emailJobSchema),
} as const;

/** Looks up the route for a stored (exchange, routingKey) pair, e.g. from the outbox. */
export function findRoute(exchange: string, routingKey: string): Route | undefined {
  return Object.values(ROUTES).find((r) => r.exchange === exchange && r.routingKey === routingKey);
}

export interface QueueDef<S extends z.ZodType = z.ZodType> {
  name: string;
  route: Route<S>;
}

function queue<S extends z.ZodType>(name: string, r: Route<S>): QueueDef<S> {
  return { name, route: r };
}

/** Where consumers read. One queue per worker type so each pool scales independently. */
export const QUEUES = {
  fetchHttp: queue('fetch.http', ROUTES.fetchHttp),
  fetchBrowser: queue('fetch.browser', ROUTES.fetchBrowser),
  contentProcess: queue('content.process', ROUTES.fetchCompleted),
  /** Consumed by the rules engine (Phase 7); declared now so results are kept until then. */
  rulesEvaluate: queue('rules.evaluate', ROUTES.contentProcessed),
  aiAnalyze: queue('ai.analyze', ROUTES.aiAnalyze),
  notifyEmail: queue('notify.email', ROUTES.notifyEmail),
} as const;

/** Backoff tiers. Attempt 1 fails → wait 5s, attempt 2 → 30s, attempt 3 → 2m, attempt 4 fails → DLQ. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export const retryQueueName = (queueName: string, delayMs: number) => `${queueName}.retry.${delayMs}`;
export const deadQueueName = (queueName: string) => `${queueName}.dead`;
