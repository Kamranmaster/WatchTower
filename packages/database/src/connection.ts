import mongoose from 'mongoose';
import type { Logger } from '@monitorly/logger';

export async function connectDatabase(uri: string, logger: Logger): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  // Build indexes automatically in development; in production run `syncIndexes()` from a deploy step.
  mongoose.set('autoIndex', process.env.NODE_ENV !== 'production');

  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ db: mongoose.connection.name }, 'Connected to MongoDB');
  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

/** True if MongoDB answers a ping. */
export async function pingDatabase(): Promise<boolean> {
  try {
    const db = mongoose.connection.db;
    if (!db) return false;
    await db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

/** Creates/updates all indexes defined on registered models. */
export async function syncAllIndexes(): Promise<void> {
  for (const model of Object.values(mongoose.models)) {
    await model.syncIndexes();
  }
}
