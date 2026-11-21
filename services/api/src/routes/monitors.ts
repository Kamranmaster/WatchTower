import { Router } from 'express';
import { z } from 'zod';
import { AiError, type AiErrorCode } from '@monitorly/ai';
import {
  createMonitorSchema,
  interpretInstructionSchema,
  objectIdString,
  updateMonitorSchema,
  type InterpretInstructionResponse,
} from '@monitorly/contracts';
import { CheckRun, Event, Monitor, Notification, Snapshot, mongoose, partitionFor } from '@monitorly/database';
import { UnsafeUrlError, assertSafeUrl } from '@monitorly/url-safety';
import type { AppDeps } from '../app';
import { currentUserId, requireAuth } from '../middleware/auth';
import { HttpError } from '../middleware/errors';
import { aiRateLimit } from '../middleware/security';
import { serializeCheckRun, serializeMonitor } from '../serializers';

const MINUTE = 60_000;

const AI_ERROR_STATUS: Record<AiErrorCode, number> = {
  not_configured: 503,
  auth: 503,
  quota_exhausted: 503,
  rate_limited: 503,
  timeout: 504,
  upstream: 502,
  bad_output: 502,
  refused: 422,
};

export function monitorsRouter(deps: AppDeps): Router {
  const { env, logger } = deps;
  const router = Router();
  router.use(requireAuth(env));

  /** Validates the URL is public and reachable by DNS; returns the normalised URL. */
  async function safeUrl(raw: string): Promise<string> {
    try {
      const { url } = await assertSafeUrl(raw, { lookup: deps.lookup });
      return url.href;
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        throw new HttpError(422, err.message, [{ path: 'url', message: err.message }]);
      }
      throw err;
    }
  }

  /**
   * Loads a monitor only if it belongs to the current user.
   * Someone else's monitor returns 404, same as a non-existent one, so IDs can't be probed.
   */
  function ownedFilter(req: { params: { id?: string } }, userId: string) {
    const id = req.params.id;
    if (!id || !objectIdString.safeParse(id).success) throw new HttpError(404, 'Monitor not found');
    return { _id: id, userId };
  }

  async function findOwned(req: { params: { id?: string } }, userId: string) {
    const monitor = await Monitor.findOne(ownedFilter(req, userId));
    if (!monitor) throw new HttpError(404, 'Monitor not found');
    return monitor;
  }

  /**
   * Natural language → proposed filters. Nothing is saved here: the user reviews the proposal,
   * and it is validated again by createMonitorSchema when they save the monitor.
   */
  router.post('/interpret', aiRateLimit(env.AI_RATE_LIMIT), async (req, res) => {
    const userId = currentUserId(req);
    const input = interpretInstructionSchema.parse(req.body);
    const { interpreter } = deps;
    if (!interpreter) {
      const err = new AiError('not_configured');
      throw new HttpError(AI_ERROR_STATUS[err.code], err.userMessage, undefined, `ai_${err.code}`);
    }

    // Stop paying for the call if the user navigates away.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const started = Date.now();
    try {
      const result = await interpreter.interpret(input, { signal: abort.signal });
      logger.info(
        { userId, provider: interpreter.provider, model: result.model, usage: result.usage, durationMs: Date.now() - started },
        'Instruction interpreted',
      );
      const body: InterpretInstructionResponse = { interpretation: result.interpretation, model: result.model };
      res.json(body);
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      // err.message holds provider details for the logs; the client gets the safe userMessage.
      logger.warn({ userId, code: err.code, detail: err.message, durationMs: Date.now() - started }, 'Instruction interpretation failed');
      throw new HttpError(AI_ERROR_STATUS[err.code], err.userMessage, undefined, `ai_${err.code}`);
    }
  });

  router.get('/', async (req, res) => {
    const userId = currentUserId(req);
    const monitors = await Monitor.find({ userId }).sort({ createdAt: -1 }).limit(200);
    res.json({ monitors: monitors.map(serializeMonitor) });
  });

  router.post('/', async (req, res) => {
    const userId = currentUserId(req);
    const input = createMonitorSchema.parse(req.body);
    const url = await safeUrl(input.url);

    const count = await Monitor.countDocuments({ userId });
    if (count >= env.MAX_MONITORS_PER_USER) {
      throw new HttpError(403, `You've reached the limit of ${env.MAX_MONITORS_PER_USER} monitors. Delete one to add another.`);
    }

    const _id = new mongoose.Types.ObjectId();
    const monitor = await Monitor.create({
      ...input,
      _id,
      userId,
      url,
      name: input.name || new URL(url).hostname,
      status: 'active',
      partitionId: partitionFor(_id.toString()),
      // Due immediately: the first check records the baseline (no alert on first check).
      nextCheckAt: new Date(),
    });

    logger.info({ userId, monitorId: monitor.id }, 'Monitor created');
    res.status(201).json({ monitor: serializeMonitor(monitor) });
  });

  router.get('/:id', async (req, res) => {
    const monitor = await findOwned(req, currentUserId(req));
    res.json({ monitor: serializeMonitor(monitor) });
  });

  /** Most recent check runs for one of the user's monitors. */
  router.get('/:id/runs', async (req, res) => {
    const monitor = await findOwned(req, currentUserId(req));
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
    const runs = await CheckRun.find({ monitorId: monitor._id }).sort({ scheduledFor: -1 }).limit(limit);
    res.json({ runs: runs.map(serializeCheckRun) });
  });

  router.patch('/:id', async (req, res) => {
    const userId = currentUserId(req);
    const input = updateMonitorSchema.parse(req.body);
    const monitor = await findOwned(req, userId);
    const { url: rawUrl, ...fields } = input;

    monitor.set(fields);
    if (fields.name === '') monitor.set('name', new URL(monitor.url).hostname);

    let urlChanged = false;
    if (rawUrl !== undefined) {
      const url = await safeUrl(rawUrl);
      if (url !== monitor.url) {
        urlChanged = true;
        monitor.url = url;
        // A different page: the old baseline is meaningless, start fresh.
        monitor.set('lastSnapshotId', undefined);
        monitor.set('resolvedFetchMode', undefined);
      }
    }

    if (monitor.status === 'active') {
      if (urlChanged) {
        monitor.nextCheckAt = new Date();
      } else if (fields.checkIntervalMinutes !== undefined) {
        const from = monitor.lastCheckedAt?.getTime() ?? Date.now();
        monitor.nextCheckAt = new Date(Math.max(Date.now(), from + monitor.checkIntervalMinutes * MINUTE));
      }
    }

    await monitor.save();
    res.json({ monitor: serializeMonitor(monitor) });
  });

  router.post('/:id/pause', async (req, res) => {
    const monitor = await Monitor.findOneAndUpdate(
      ownedFilter(req, currentUserId(req)),
      { $set: { status: 'paused' } },
      { new: true },
    );
    if (!monitor) throw new HttpError(404, 'Monitor not found');
    res.json({ monitor: serializeMonitor(monitor) });
  });

  router.post('/:id/resume', async (req, res) => {
    const monitor = await Monitor.findOneAndUpdate(
      ownedFilter(req, currentUserId(req)),
      // Check right away, and clear any error state from before the pause.
      { $set: { status: 'active', nextCheckAt: new Date(), consecutiveFailures: 0 }, $unset: { lastError: 1 } },
      { new: true },
    );
    if (!monitor) throw new HttpError(404, 'Monitor not found');
    res.json({ monitor: serializeMonitor(monitor) });
  });

  router.delete('/:id', async (req, res) => {
    const userId = currentUserId(req);
    // Delete the monitor first so the scheduler stops picking it up, then its history.
    const monitor = await Monitor.findOneAndDelete(ownedFilter(req, userId));
    if (!monitor) throw new HttpError(404, 'Monitor not found');

    const monitorId = monitor._id;
    await Promise.all([
      CheckRun.deleteMany({ monitorId }),
      Snapshot.deleteMany({ monitorId }),
      Event.deleteMany({ monitorId }),
      Notification.deleteMany({ monitorId }),
    ]);
    // TODO(Phase 5): also delete this monitor's snapshot objects from object storage.

    logger.info({ userId, monitorId: monitor.id }, 'Monitor deleted');
    res.status(204).end();
  });

  return router;
}
