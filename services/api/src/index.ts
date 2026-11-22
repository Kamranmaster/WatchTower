import http from 'node:http';
import { createAiInterpreter, resolveAiConfig } from '@monitorly/ai';
import { ROUTES } from '@monitorly/contracts';
import { connectDatabase, disconnectDatabase } from '@monitorly/database';
import { createLogger } from '@monitorly/logger';
import { MessageBus } from '@monitorly/messaging';
import { runService } from '@monitorly/runtime';
import { S3ObjectStore } from '@monitorly/storage';
import { createApp } from './app';
import { env } from './config';
import { attachRealtime } from './realtime';

const logger = createLogger('api');

runService(logger, async ({ fail }) => {
  await connectDatabase(env.MONGODB_URI, logger);
  const bus = await MessageBus.connect(env.RABBITMQ_URL, {
    logger,
    connectionName: `api-${process.pid}`,
    onUnexpectedClose: (err) => fail('Lost connection to RabbitMQ', err),
  });

  const aiConfig = resolveAiConfig(env);
  const interpreter = aiConfig ? createAiInterpreter(aiConfig) : undefined;
  if (interpreter) {
    logger.info({ provider: interpreter.provider, model: interpreter.model }, 'AI filter suggestions enabled');
  } else {
    logger.warn(`AI_API_KEY not set (AI_PROVIDER=${env.AI_PROVIDER}): AI filter suggestions disabled, filters must be entered manually`);
  }

  const store = S3ObjectStore.fromEnv(env);
  const server = http.createServer(createApp({ env, logger, bus, store, interpreter }));
  // Live updates: every new in-app notification is pushed to the user's open tabs.
  const realtime = attachRealtime(server, { env, logger });
  await bus.subscribe(ROUTES.notificationCreated, (msg) => realtime.pushNotification(msg));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.API_PORT, resolve);
  });
  logger.info(`API listening on http://localhost:${env.API_PORT}`);

  return {
    stop: async () => {
      // Disconnect live-update sockets and stop accepting connections (in-flight requests
      // finish), then close dependencies.
      await realtime.close();
      await bus.close();
      await disconnectDatabase();
    },
  };
});
