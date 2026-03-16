import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '../utils/fetchWithRetry';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('fetchWithRetry', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately on success (200)', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, { ok: true }));

    const res = await fetchWithRetry('/api/test');

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('does not retry on 400 (client error)', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, { error: 'Bad request' }));

    const res = await fetchWithRetry('/api/test');

    expect(res.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('does not retry on 401 (auth error)', async () => {
    mockFetch.mockResolvedValue(mockResponse(401));

    const res = await fetchWithRetry('/api/test');

    expect(res.status).toBe(401);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('does not retry on 429 (rate limit)', async () => {
    mockFetch.mockResolvedValue(mockResponse(429));

    const res = await fetchWithRetry('/api/test');

    expect(res.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('retries on 502 and succeeds on second attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(502))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const promise = fetchWithRetry('/api/test', { maxRetries: 2 });
    await vi.advanceTimersByTimeAsync(1500);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 and succeeds on third attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const promise = fetchWithRetry('/api/test', { maxRetries: 2 });
    await vi.advanceTimersByTimeAsync(1500); // 1st retry after 1s
    await vi.advanceTimersByTimeAsync(2500); // 2nd retry after 2s
    const res = await promise;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('returns last error response after exhausting retries', async () => {
    mockFetch.mockResolvedValue(mockResponse(502));

    const promise = fetchWithRetry('/api/test', { maxRetries: 2 });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(2500);
    const res = await promise;

    expect(res.status).toBe(502);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network error (TypeError) and succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));

    const promise = fetchWithRetry('/api/test', { maxRetries: 2 });
    await vi.advanceTimersByTimeAsync(1500);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws network error with no retries left', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    // maxRetries=0 means no retries, just the initial attempt
    await expect(
      fetchWithRetry('/api/test', { maxRetries: 0 }),
    ).rejects.toThrow('Failed to fetch');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('does not retry on AbortError (user cancellation)', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    mockFetch.mockRejectedValue(abortError);

    await expect(
      fetchWithRetry('/api/test', { maxRetries: 2 }),
    ).rejects.toThrow('Aborted');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('retries on 504 (gateway timeout)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(504))
      .mockResolvedValueOnce(mockResponse(200));

    const promise = fetchWithRetry('/api/test', { maxRetries: 1 });
    await vi.advanceTimersByTimeAsync(1500);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 500 (not in retryable set)', async () => {
    mockFetch.mockResolvedValue(mockResponse(500));

    const res = await fetchWithRetry('/api/test', { maxRetries: 2 });

    expect(res.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('passes through fetch options correctly', async () => {
    mockFetch.mockResolvedValue(mockResponse(200));

    await fetchWithRetry('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"foo":"bar"}',
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"foo":"bar"}',
    });
  });

  it('defaults to maxRetries=2 when not specified', async () => {
    mockFetch.mockResolvedValue(mockResponse(503));

    const promise = fetchWithRetry('/api/test');
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(2500);
    const res = await promise;

    expect(res.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
