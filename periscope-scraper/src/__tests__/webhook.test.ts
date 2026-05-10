import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  loadWebhookConfig,
  postPlaybookWebhook,
  type Fetcher,
  type WebhookConfig,
  type WebhookInput,
} from '../webhook.js';

const VALID_INPUT: WebhookInput = {
  tradingDate: '2026-05-12',
  capturedAt: '2026-05-12T13:30:00.000Z',
  slotKey: '08:30 - 08:40',
};

function configWith(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    baseUrl: 'https://theta-options.com',
    secret: 'test-secret',
    timeoutMs: 50,
    retryBackoffMs: 0,
    ...overrides,
  };
}

function mockResponse(status: number, body = ''): Awaited<ReturnType<Fetcher>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  };
}

beforeEach(() => {
  delete process.env.VERCEL_BASE_URL;
  delete process.env.PERISCOPE_WEBHOOK_SECRET;
});

describe('loadWebhookConfig', () => {
  it('returns nulls when env vars are unset', () => {
    const c = loadWebhookConfig();
    expect(c.baseUrl).toBeNull();
    expect(c.secret).toBeNull();
  });

  it('returns nulls when env vars are blank', () => {
    process.env.VERCEL_BASE_URL = '   ';
    process.env.PERISCOPE_WEBHOOK_SECRET = '';
    const c = loadWebhookConfig();
    expect(c.baseUrl).toBeNull();
    expect(c.secret).toBeNull();
  });

  it('strips trailing slashes from baseUrl', () => {
    process.env.VERCEL_BASE_URL = 'https://theta-options.com//';
    process.env.PERISCOPE_WEBHOOK_SECRET = 'abc';
    const c = loadWebhookConfig();
    expect(c.baseUrl).toBe('https://theta-options.com');
    expect(c.secret).toBe('abc');
  });
});

describe('postPlaybookWebhook — config gating', () => {
  it('skips when baseUrl is missing', async () => {
    const fetcher = vi.fn();
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ baseUrl: null, fetcher }),
    );
    expect(result).toEqual({
      ok: true,
      status: null,
      attempts: 0,
      skipped: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips when secret is missing', async () => {
    const fetcher = vi.fn();
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ secret: null, fetcher }),
    );
    expect(result.skipped).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('postPlaybookWebhook — request shape', () => {
  it('posts JSON body with Bearer auth + correct URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse(202));
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher }),
    );
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://theta-options.com/api/periscope-auto-playbook');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-secret');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      tradingDate: '2026-05-12',
      capturedAt: '2026-05-12T13:30:00.000Z',
      slotKey: '08:30 - 08:40',
    });
  });
});

describe('postPlaybookWebhook — success cases', () => {
  it('returns ok=true on 202 (in_progress kicked off)', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse(202));
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher }),
    );
    expect(result).toMatchObject({
      ok: true,
      status: 202,
      attempts: 1,
      skipped: false,
    });
  });

  it('returns ok=true on 200 (idempotent — row already existed)', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse(200));
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher }),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('treats 422 as success (slot is non-analyzable, no retry)', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse(422, 'pre-market'));
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher }),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(422);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('postPlaybookWebhook — failure + retry', () => {
  it('does NOT retry on 401 (auth failure)', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse(401, 'Unauthorized'));
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.attempts).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('401');
  });

  it('does NOT retry on 400 (bad body)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockResponse(400, 'Invalid body'));
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher }),
    );
    expect(result.ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries once on 500, succeeds on second attempt', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(500))
      .mockResolvedValueOnce(mockResponse(202));
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher }),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(result.attempts).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('gives up after second 5xx', async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse(503));
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher }),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.attempts).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries once on a network throw, succeeds on second attempt', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(mockResponse(202));
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher }),
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('aborts on timeout and includes the abort error in the result', async () => {
    const fetcher: Fetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const result = await postPlaybookWebhook(
      VALID_INPUT,
      configWith({ fetcher, timeoutMs: 5, retryBackoffMs: 0 }),
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.error).toContain('AbortError');
  });
});
