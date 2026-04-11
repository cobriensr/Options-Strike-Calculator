// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @axiomhq/js ─────────────────────────────────────────
// vi.hoisted runs before import hoisting, so the mock factory can
// reference these before the module is loaded.

const { mockIngest, constructorSpy, mockOptionalEnv } = vi.hoisted(() => ({
  mockIngest: vi.fn().mockResolvedValue(undefined),
  constructorSpy: vi.fn(),
  mockOptionalEnv: vi.fn<(key: string) => string | undefined>(),
}));

vi.mock('@axiomhq/js', () => ({
  AxiomWithoutBatching: class {
    ingest = mockIngest;
    constructor(opts: { token: string }) {
      constructorSpy(opts);
    }
  },
}));

vi.mock('../_lib/env.js', () => ({
  optionalEnv: mockOptionalEnv,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { reportCronRun, _resetClient } from '../_lib/axiom.js';
import logger from '../_lib/logger.js';

// ── Helpers ───────────────────────────────────────────────────

const API_KEY = 'xapt-test-key';
const DATASET = 'cron-metrics';

function withBothEnvs() {
  mockOptionalEnv.mockImplementation((key) => {
    if (key === 'AXIOM_API_KEY') return API_KEY;
    if (key === 'AXIOM_DATASET') return DATASET;
    return undefined;
  });
}

beforeEach(() => {
  _resetClient();
  mockIngest.mockClear();
  constructorSpy.mockClear();
  mockOptionalEnv.mockReset();
  vi.mocked(logger.warn).mockClear();
});

// ── No-op paths ───────────────────────────────────────────────

describe('reportCronRun: no-op when env vars absent', () => {
  it('skips ingest when AXIOM_API_KEY is not set', async () => {
    mockOptionalEnv.mockReturnValue(undefined);

    await reportCronRun('fetch-darkpool', { status: 'ok' });

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('skips ingest when AXIOM_DATASET is not set', async () => {
    mockOptionalEnv.mockImplementation((key) =>
      key === 'AXIOM_API_KEY' ? API_KEY : undefined,
    );

    await reportCronRun('fetch-darkpool', { status: 'ok' });

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('does not throw in either no-op case', async () => {
    mockOptionalEnv.mockReturnValue(undefined);
    await expect(
      reportCronRun('fetch-darkpool', { status: 'ok' }),
    ).resolves.toBeUndefined();
  });
});

// ── Happy path ────────────────────────────────────────────────

describe('reportCronRun: successful ingest', () => {
  beforeEach(withBothEnvs);

  it('calls ingest with dataset and job merged into payload', async () => {
    await reportCronRun('fetch-darkpool', { status: 'ok', trades: 42 });

    expect(mockIngest).toHaveBeenCalledOnce();
    expect(mockIngest).toHaveBeenCalledWith(DATASET, {
      job: 'fetch-darkpool',
      status: 'ok',
      trades: 42,
    });
  });

  it('constructs the Axiom client with the API key', async () => {
    await reportCronRun('fetch-darkpool', { status: 'ok' });

    expect(constructorSpy).toHaveBeenCalledOnce();
    expect(constructorSpy).toHaveBeenCalledWith({ token: API_KEY });
  });

  it('reuses the singleton — constructor called only once across multiple runs', async () => {
    await reportCronRun('job-a', { status: 'ok' });
    await reportCronRun('job-b', { status: 'skipped' });

    expect(constructorSpy).toHaveBeenCalledOnce();
    expect(mockIngest).toHaveBeenCalledTimes(2);
  });

  it('resolves to undefined on success', async () => {
    await expect(
      reportCronRun('fetch-darkpool', { status: 'ok' }),
    ).resolves.toBeUndefined();
  });
});

// ── Error handling ────────────────────────────────────────────

describe('reportCronRun: ingest failure', () => {
  beforeEach(withBothEnvs);

  it('swallows the error and does not throw', async () => {
    mockIngest.mockRejectedValueOnce(new Error('network timeout'));

    await expect(
      reportCronRun('fetch-darkpool', { status: 'ok' }),
    ).resolves.toBeUndefined();
  });

  it('logs a warning with the error when ingest throws', async () => {
    const err = new Error('network timeout');
    mockIngest.mockRejectedValueOnce(err);

    await reportCronRun('fetch-darkpool', { status: 'ok' });

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      { err },
      'axiom: reportCronRun failed',
    );
  });
});
