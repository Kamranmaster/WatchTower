import { Router } from 'express';
import { pingDatabase } from '@monitorly/database';
import type { AppDeps } from '../app';

export function healthRouter({ bus, store }: AppDeps): Router {
  const router = Router();

  /** Liveness: the process is up. Orchestrators restart the container if this fails. */
  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** Readiness: dependencies are reachable. Load balancers stop routing here if this fails. */
  router.get('/ready', async (_req, res) => {
    const [mongodb, storage] = await Promise.all([
      pingDatabase(),
      store.ping().then(
        () => true,
        () => false,
      ),
    ]);
    const rabbitmq = bus.isHealthy;
    const ok = mongodb && rabbitmq && storage;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      checks: {
        mongodb: mongodb ? 'up' : 'down',
        rabbitmq: rabbitmq ? 'up' : 'down',
        storage: storage ? 'up' : 'down',
      },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  return router;
}
