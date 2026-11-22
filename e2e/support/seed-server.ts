/**
 * Test-only helper server for the browser tests. It writes the data the pipeline workers
 * would produce (changes, verdicts, check runs, notifications) straight into the e2e database,
 * and publishes notification.created on RabbitMQ so the real API pushes live alerts to the
 * browser. It is never part of the product: it only listens on 127.0.0.1 and only runs
 * under Playwright (see playwright.config.ts).
 */
import http from 'node:http';
import { ROUTES } from '@monitorly/contracts';
import { CheckRun, Event, Monitor, Notification, connectDatabase, mongoose, syncAllIndexes } from '@monitorly/database';
import { createLogger } from '@monitorly/logger';
import { MessageBus, createEnvelope } from '@monitorly/messaging';
import { E2E } from './env';

const logger = createLogger('e2e-seed');

type Verdict = 'matched' | 'filtered_out' | 'not_relevant' | 'pending';
interface EventSpec {
  title: string;
  eventType?: 'new_item' | 'item_changed' | 'item_removed' | 'page_changed';
  verdict?: Verdict;
  description?: string;
  minutesAgo?: number;
  reasons?: string[];
  summary?: string;
}

await connectDatabase(E2E.mongoUri, logger);
await syncAllIndexes();
const bus = await MessageBus.connect(E2E.rabbitUrl, { logger, connectionName: 'e2e-seed' });

async function ownedMonitor(monitorId: string) {
  const monitor = await Monitor.findById(monitorId);
  if (!monitor) throw Object.assign(new Error(`No monitor ${monitorId}`), { status: 404 });
  return monitor;
}

let seq = 0;
async function insertEvents(monitorId: string, specs: EventSpec[]) {
  const monitor = await ownedMonitor(monitorId);
  const run = await CheckRun.create({
    monitorId,
    userId: monitor.userId,
    scheduledFor: new Date(Date.now() - 1000 * ++seq),
    status: 'succeeded',
    outcome: 'changed',
    changeCount: specs.length,
  });
  const now = Date.now();
  const docs = specs.map((spec, i) => {
    const verdict = spec.verdict ?? 'matched';
    const detectedAt = new Date(now - (spec.minutesAgo ?? i) * 60_000);
    return {
      monitorId,
      userId: monitor.userId,
      checkRunId: run._id,
      eventType: spec.eventType ?? 'new_item',
      title: spec.title,
      description: spec.description,
      sourceUrl: `https://example.com/jobs/${encodeURIComponent(spec.title.toLowerCase().replace(/\s+/g, '-'))}`,
      fingerprint: `seed-${now}-${seq}-${i}`,
      detectedAt,
      match: {
        status: verdict === 'filtered_out' ? 'filtered_out' : verdict === 'pending' ? 'pending' : 'matched',
        reasons: verdict === 'filtered_out' ? (spec.reasons ?? ['doesn’t mention “intern”']) : undefined,
        matchedTerms: verdict === 'matched' ? ['intern'] : undefined,
        evaluatedAt: verdict === 'pending' ? undefined : detectedAt,
      },
      ai:
        verdict === 'matched' || verdict === 'not_relevant'
          ? {
              status: 'done',
              relevant: verdict === 'matched',
              summary: verdict === 'matched' ? (spec.summary ?? `${spec.title} is open.`) : undefined,
              reason: verdict === 'not_relevant' ? 'Not the kind of role you asked for' : undefined,
            }
          : { status: 'skipped' },
      ...(verdict === 'matched' ? { alertedAt: detectedAt } : {}),
    };
  });
  const events = await Event.insertMany(docs);
  await Monitor.updateOne({ _id: monitorId }, { $set: { lastChangeAt: new Date(now), lastCheckedAt: new Date(now) } });
  return { monitor, events };
}

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  /** Empties every collection (indexes stay). */
  async '/reset'() {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
    return { ok: true };
  },

  /** Changes with verdicts on a monitor. */
  async '/events'(body) {
    const { events } = await insertEvents(String(body.monitorId), body.events as EventSpec[]);
    return { ids: events.map((e) => e.id as string) };
  },

  /** Finished check runs, newest first. */
  async '/runs'(body) {
    const monitor = await ownedMonitor(String(body.monitorId));
    const count = Number(body.count ?? 1);
    const now = Date.now();
    await CheckRun.insertMany(
      Array.from({ length: count }, (_, i) => ({
        monitorId: monitor._id,
        userId: monitor.userId,
        scheduledFor: new Date(now - (i + 1) * 30 * 60_000),
        status: 'succeeded',
        attempts: 1,
        fetchModeUsed: 'http',
        outcome: 'unchanged',
        durationMs: 1200,
        completedAt: new Date(now - (i + 1) * 30 * 60_000 + 1200),
      })),
    );
    await Monitor.updateOne({ _id: monitor._id }, { $set: { lastCheckedAt: new Date(now - 30 * 60_000) } });
    return { ok: true };
  },

  /** Puts a monitor in the failing state, as the fetch pipeline does after repeated errors. */
  async '/fail'(body) {
    await ownedMonitor(String(body.monitorId));
    await Monitor.updateOne(
      { _id: body.monitorId },
      { $set: { status: 'error', consecutiveFailures: 3, lastError: String(body.error ?? 'The page took too long to respond') } },
    );
    return { ok: true };
  },

  /**
   * Matched changes with their notifications. `live: true` also publishes
   * notification.created, exactly like the notification worker, so open tabs get a pop-up.
   */
  async '/notify'(body) {
    const count = Number(body.count ?? 1);
    const titles = Array.from({ length: count }, (_, i) => (count === 1 ? String(body.title ?? 'Frontend Intern') : `Role ${i + 1}`));
    const { monitor, events } = await insertEvents(
      String(body.monitorId),
      titles.map((title, i) => ({ title, description: 'Remote', minutesAgo: count - i })),
    );
    const now = Date.now();
    const notifications = await Notification.insertMany(
      events.map((e, i) => ({
        userId: monitor.userId,
        monitorId: monitor._id,
        eventId: e._id,
        eventType: 'new_item',
        title: `New: ${e.title}`,
        message: `${e.title} (Remote)`,
        sourceUrl: e.sourceUrl,
        isRead: body.read === true,
        createdAt: new Date(now - (count - i) * 1000),
      })),
    );
    if (body.live) {
      for (const n of notifications) {
        await bus.publish(ROUTES.notificationCreated, { ...createEnvelope(), notificationId: n.id, userId: String(monitor.userId) });
      }
    }
    return { notifications: notifications.map((n) => ({ id: n.id as string, eventId: String(n.eventId) })) };
  },
};

const server = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
  const handler = req.method === 'POST' && req.url ? routes[req.url] : undefined;
  if (!handler) return reply(404, { error: 'not found' });
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    handler(raw ? JSON.parse(raw) : {})
      .then((body) => reply(200, body))
      .catch((err: Error & { status?: number }) => {
        logger.error({ err }, 'Seed request failed');
        reply(err.status ?? 500, { error: err.message });
      });
  });
});

server.listen(E2E.seedPort, '127.0.0.1', () => logger.info(`Seed server on ${E2E.seedUrl}`));

const stop = async () => {
  server.close();
  await bus.close().catch(() => undefined);
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
