import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn());
const clientCtor = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: unknown) {
      clientCtor(config);
    }
    send = sendMock;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  HeadObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

const R2_VARS = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key-id',
  R2_SECRET_ACCESS_KEY: 'key-secret',
  R2_ENDPOINT_URL: 'https://acct.r2.cloudflarestorage.com',
  R2_BUCKET_FULLTAPE: 'tape-bucket',
} as const;

function stubAllR2Env(): void {
  for (const [k, v] of Object.entries(R2_VARS)) vi.stubEnv(k, v);
}

async function loadR2() {
  return import('../_lib/r2.js');
}

beforeEach(() => {
  vi.resetModules();
  sendMock.mockReset();
  clientCtor.mockReset();
  stubAllR2Env();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getR2Bucket', () => {
  it('returns the bucket name when all five vars are set', async () => {
    const { getR2Bucket } = await loadR2();
    expect(getR2Bucket()).toBe('tape-bucket');
  });

  it('throws naming every missing var', async () => {
    vi.stubEnv('R2_ACCESS_KEY_ID', '');
    vi.stubEnv('R2_BUCKET_FULLTAPE', '');
    const { getR2Bucket } = await loadR2();
    expect(() => getR2Bucket()).toThrow(
      'R2 is not configured: R2_ACCESS_KEY_ID, R2_BUCKET_FULLTAPE',
    );
  });
});

describe('r2PutObject', () => {
  it('sends Bucket, Key, Body, ContentType and Metadata', async () => {
    sendMock.mockResolvedValueOnce({});
    const { r2PutObject } = await loadR2();
    const body = new Uint8Array([1, 2, 3]);
    await r2PutObject('gexbot-eod/SPX/2026-10-28.zip', body, {
      contentType: 'application/zip',
      metadata: { sha256: 'abc', source: 'cron' },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0]?.[0] as { input: unknown };
    expect(cmd.input).toEqual({
      Bucket: 'tape-bucket',
      Key: 'gexbot-eod/SPX/2026-10-28.zip',
      Body: body,
      ContentType: 'application/zip',
      Metadata: { sha256: 'abc', source: 'cron' },
    });
  });

  it('builds one client with R2 settings and reuses it', async () => {
    sendMock.mockResolvedValue({});
    const { r2PutObject } = await loadR2();
    const opts = { contentType: 'application/zip', metadata: {} };
    await r2PutObject('a', new Uint8Array(1), opts);
    await r2PutObject('b', new Uint8Array(1), opts);
    expect(clientCtor).toHaveBeenCalledTimes(1);
    expect(clientCtor).toHaveBeenCalledWith({
      region: 'auto',
      endpoint: R2_VARS.R2_ENDPOINT_URL,
      forcePathStyle: true,
      credentials: {
        accessKeyId: R2_VARS.R2_ACCESS_KEY_ID,
        secretAccessKey: R2_VARS.R2_SECRET_ACCESS_KEY,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  });

  it('rejects when the SDK rejects', async () => {
    sendMock.mockRejectedValueOnce(new Error('AccessDenied'));
    const { r2PutObject } = await loadR2();
    await expect(
      r2PutObject('k', new Uint8Array(1), {
        contentType: 'application/zip',
        metadata: {},
      }),
    ).rejects.toThrow('AccessDenied');
  });

  it('rejects with the config error when R2 is not configured', async () => {
    vi.stubEnv('R2_ENDPOINT_URL', '');
    const { r2PutObject } = await loadR2();
    await expect(
      r2PutObject('k', new Uint8Array(1), {
        contentType: 'application/zip',
        metadata: {},
      }),
    ).rejects.toThrow('R2 is not configured: R2_ENDPOINT_URL');
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('r2HeadObject', () => {
  it('maps ContentLength, ETag and Metadata and strips the etag quotes', async () => {
    sendMock.mockResolvedValueOnce({
      ContentLength: 42,
      ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
      Metadata: { sha256: 'abc' },
    });
    const { r2HeadObject } = await loadR2();
    const res = await r2HeadObject('gexbot-eod/SPX/2026-10-28.zip');
    expect(res).toEqual({
      contentLength: 42,
      etag: 'd41d8cd98f00b204e9800998ecf8427e',
      metadata: { sha256: 'abc' },
    });
    const cmd = sendMock.mock.calls[0]?.[0] as { input: unknown };
    expect(cmd.input).toEqual({
      Bucket: 'tape-bucket',
      Key: 'gexbot-eod/SPX/2026-10-28.zip',
    });
  });

  it('defaults missing fields to empty values', async () => {
    sendMock.mockResolvedValueOnce({});
    const { r2HeadObject } = await loadR2();
    expect(await r2HeadObject('k')).toEqual({
      contentLength: 0,
      etag: '',
      metadata: {},
    });
  });

  it('returns null when the error name is NotFound', async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error('nf'), { name: 'NotFound' }),
    );
    const { r2HeadObject } = await loadR2();
    expect(await r2HeadObject('k')).toBeNull();
  });

  it('returns null on an HTTP 404 status', async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error('missing'), {
        name: 'UnknownError',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const { r2HeadObject } = await loadR2();
    expect(await r2HeadObject('k')).toBeNull();
  });

  it('rethrows a 500', async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error('boom'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      }),
    );
    const { r2HeadObject } = await loadR2();
    await expect(r2HeadObject('k')).rejects.toThrow('boom');
  });

  it('rethrows a non-object rejection', async () => {
    sendMock.mockRejectedValueOnce('plain string');
    const { r2HeadObject } = await loadR2();
    await expect(r2HeadObject('k')).rejects.toBe('plain string');
  });
});
