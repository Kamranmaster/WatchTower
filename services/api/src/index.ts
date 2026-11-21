import http from 'node:http';
import { createAiInterpreter, resolveAiConfig } from '@monitorly/ai';
import { connectDatabase, disconnectDatabase } from '@monitorly/database';
import { createLogger } from '@monitorly/logger';
import { MessageBus } from '@monitorly/messaging';
import { runService } from '@monitorly/runtime';
import { createApp } from './app';
import { env } from './config';

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

  const server = http.createServer(createApp({ env, logger, bus, interpreter }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.API_PORT, resolve);
  });
  logger.info(`API listening on http://localhost:${env.API_PORT}`);

  return {
    stop: async () => {
      // Stop accepting connections, let in-flight requests finish, then close dependencies.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await bus.close();
      await disconnectDatabase();
    },
  };
});
