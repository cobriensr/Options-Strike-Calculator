/**
 * Private Cloudflare R2 object storage (S3-compatible).
 *
 * Holds the GEXBot end-of-day ZIPs (and the local tape scripts' files). The
 * bucket is private: nothing serves these objects (data-licensing rule).
 *
 * Config is read lazily, at first use, so importing this module never throws
 * in functions that don't touch R2. One module-level client is reused across
 * invocations; it is a single bounded object, not a per-request cache (R1).
 */

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { optionalEnv } from './env.js';

const R2_VARS = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT_URL',
  'R2_BUCKET_FULLTAPE',
] as const;

interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
}

export interface R2HeadResult {
  contentLength: number;
  /** Quotes stripped. For a single-part upload this is the body's MD5. */
  etag: string;
  metadata: Record<string, string>;
}

function readConfig(): R2Config {
  const missing = R2_VARS.filter((name) => !optionalEnv(name));
  if (missing.length > 0) {
    throw new Error(`R2 is not configured: ${missing.join(', ')}`);
  }
  return {
    accessKeyId: optionalEnv('R2_ACCESS_KEY_ID') ?? '',
    secretAccessKey: optionalEnv('R2_SECRET_ACCESS_KEY') ?? '',
    endpoint: optionalEnv('R2_ENDPOINT_URL') ?? '',
    bucket: optionalEnv('R2_BUCKET_FULLTAPE') ?? '',
  };
}

/** The name of the private bucket. Throws when R2 is not configured. */
export function getR2Bucket(): string {
  return readConfig().bucket;
}

let client: S3Client | null = null;

function getClient(config: R2Config): S3Client {
  client ??= new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // R2 does not accept the SDK's default CRC32 trailer checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

/** Upload one object. Rejects on any SDK or network error. */
export async function r2PutObject(
  key: string,
  body: Uint8Array,
  opts: { contentType: string; metadata: Record<string, string> },
): Promise<void> {
  const config = readConfig();
  await getClient(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: opts.contentType,
      Metadata: opts.metadata,
    }),
  );
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

/** Object metadata, or `null` when the key does not exist. */
export async function r2HeadObject(key: string): Promise<R2HeadResult | null> {
  const config = readConfig();
  try {
    const res = await getClient(config).send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    return {
      contentLength: res.ContentLength ?? 0,
      etag: (res.ETag ?? '').replaceAll('"', ''),
      metadata: res.Metadata ?? {},
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
