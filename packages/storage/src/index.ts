import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Env fields for services that use object storage. Spread into a service's env schema. */
export const storageEnvFields = {
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** Needed for SeaweedFS/MinIO (bucket in the path, not the hostname). */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
};
type StorageEnv = z.output<z.ZodObject<typeof storageEnvFields>>;

export interface PutOptions {
  contentType?: string;
  contentEncoding?: string;
  metadata?: Record<string, string>;
}

/** The small surface the app needs — implemented by S3 and by an in-memory store for tests. */
export interface ObjectStore {
  put(key: string, body: Buffer, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Deletes every object under a prefix; returns how many were deleted. */
  deletePrefix(prefix: string): Promise<number>;
  /** Throws if the bucket is unreachable. */
  ping(): Promise<void>;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    config: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean },
  ) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // SeaweedFS/MinIO don't need the newer default checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  static fromEnv(env: StorageEnv): S3ObjectStore {
    return new S3ObjectStore(env.S3_BUCKET, {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentEncoding: options.contentEncoding,
        Metadata: options.metadata,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Object ${key} has no body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix || !prefix.endsWith('/')) throw new Error('deletePrefix needs a folder-like prefix ending in "/"');
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

/** For tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; options: PutOptions }>();

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), options });
  }

  async get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) throw Object.assign(new Error(`NoSuchKey: ${key}`), { name: 'NoSuchKey' });
    return object.body;
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  async ping(): Promise<void> {}
}

// ---------------------------------------------------------------- Snapshot layout
/** All of a monitor's stored objects live under this prefix (deleted together with the monitor). */
export const monitorPrefix = (monitorId: string) => `snapshots/${monitorId}/`;

/** Raw page for one check, gzip-compressed. Same key on retry → overwrite, never duplicates. */
export const rawSnapshotKey = (monitorId: string, checkRunId: string) => `${monitorPrefix(monitorId)}${checkRunId}.html.gz`;

/** Extracted, normalized items for one check (JSON). */
export const itemsSnapshotKey = (monitorId: string, checkRunId: string) => `${monitorPrefix(monitorId)}${checkRunId}.items.json.gz`;

/** Stores page text gzip-compressed (HTML compresses ~5–10×). */
export async function putCompressedText(
  store: ObjectStore,
  key: string,
  text: string,
  contentType = 'text/html; charset=utf-8',
): Promise<{ storedBytes: number }> {
  const body = await gzipAsync(Buffer.from(text, 'utf8'));
  await store.put(key, body, { contentType, contentEncoding: 'gzip' });
  return { storedBytes: body.length };
}

export async function getCompressedText(store: ObjectStore, key: string): Promise<string> {
  return (await gunzipAsync(await store.get(key))).toString('utf8');
}
