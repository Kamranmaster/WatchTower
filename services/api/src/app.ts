import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { InstructionInterpreter } from '@monitorly/ai';
import type { Logger } from '@monitorly/logger';
import type { MessageBus } from '@monitorly/messaging';
import type { LookupFn } from '@monitorly/url-safety';
import type { Env } from './env';
import { errorHandler, notFound } from './middleware/errors';
import { sameOriginOnly } from './middleware/security';
import { authRouter } from './routes/auth';
import { devRouter } from './routes/dev';
import { healthRouter } from './routes/health';
import { monitorsRouter } from './routes/monitors';

export interface AppDeps {
  env: Env;
  logger: Logger;
  bus: MessageBus;
  /** DNS resolver override for URL safety checks (tests). */
  lookup?: LookupFn;
  /** Natural language → rules. Undefined when no OpenAI key is configured (users fill filters manually). */
  interpreter?: InstructionInterpreter;
}

export function createApp(deps: AppDeps): Express {
  const { env, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );

  app.get('/', (_req, res) => {
    res.json({
      service: 'monitorly-api',
      message: 'This is the API. Open the web app at ' + env.WEB_ORIGIN,
      endpoints: ['/health/live', '/health/ready', ...(env.NODE_ENV !== 'production' ? ['/api/dev/queues'] : [])],
    });
  });
  app.use('/health', healthRouter(deps));

  app.use('/api', sameOriginOnly(env.WEB_ORIGIN));
  app.use('/api/auth', authRouter(deps));
  app.use('/api/monitors', monitorsRouter(deps));
  if (env.NODE_ENV !== 'production') {
    app.use('/api/dev', devRouter(deps));
  }

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
