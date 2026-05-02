/**
 * Unit tests for the daemon's health endpoint status logic. The HTTP
 * server is exercised indirectly via `computeHealthStatus`, which is
 * the pure decision function the request handler delegates to.
 *
 * The 503-on-wedged-daemon detection lets Railway's liveness probe
 * bounce a stuck container instead of leaving it failing every cycle
 * indefinitely.
 */

import { describe, it, expect } from 'vitest';
import {
  computeHealthStatus,
  WEDGED_DAEMON_THRESHOLD_MS,
} from '../src/health-server';
import type { SchedulerState } from '../src/scheduler';

const baseState: SchedulerState = {
  status: 'running',
  inFlight: false,
  lastTickAt: '2026-05-01T15:00:00.000Z',
  lastSuccessAt: '2026-05-01T15:00:00.000Z',
  lastFailAt: null,
  lastError: null,
  lastDurationMs: 1234,
  marketHours: {
    inWindow: true,
    reason: 'in window',
    etDate: '2026-05-01',
    etMinutes: 600,
  },
  startedAt: '2026-05-01T13:30:00.000Z',
  totals: {
    succeeded: 10,
    failed: 0,
    skippedInFlight: 0,
    skippedOutOfWindow: 0,
  },
};

describe('computeHealthStatus', () => {
  it('returns 200 when running and last cycle succeeded', () => {
    expect(computeHealthStatus(baseState, 60_000)).toBe(200);
  });

  it('returns 503 when scheduler.status is "stopped"', () => {
    expect(
      computeHealthStatus({ ...baseState, status: 'stopped' }, 60_000),
    ).toBe(503);
  });

  it('returns 503 when scheduler.status is "idle" (never started)', () => {
    expect(
      computeHealthStatus({ ...baseState, status: 'idle' }, 60_000),
    ).toBe(503);
  });

  it('returns 503 when wedged: lastFailAt > lastSuccessAt and uptime past recovery window', () => {
    const wedged: SchedulerState = {
      ...baseState,
      lastSuccessAt: '2026-05-01T13:30:00.000Z',
      lastFailAt: '2026-05-01T15:00:00.000Z',
    };
    expect(
      computeHealthStatus(wedged, WEDGED_DAEMON_THRESHOLD_MS + 1000),
    ).toBe(503);
  });

  it('returns 503 when only failures observed and uptime past recovery window', () => {
    const wedged: SchedulerState = {
      ...baseState,
      lastSuccessAt: null,
      lastFailAt: '2026-05-01T15:00:00.000Z',
    };
    expect(
      computeHealthStatus(wedged, WEDGED_DAEMON_THRESHOLD_MS + 1000),
    ).toBe(503);
  });

  it('returns 200 during recovery window (recent fail, not yet wedged)', () => {
    const recovering: SchedulerState = {
      ...baseState,
      lastSuccessAt: '2026-05-01T13:30:00.000Z',
      lastFailAt: '2026-05-01T15:00:00.000Z',
    };
    // Uptime is below the 30-min threshold — give it time to recover.
    expect(
      computeHealthStatus(recovering, WEDGED_DAEMON_THRESHOLD_MS - 1000),
    ).toBe(200);
  });

  it('returns 200 when lastFailAt < lastSuccessAt (recovered)', () => {
    const recovered: SchedulerState = {
      ...baseState,
      lastFailAt: '2026-05-01T13:00:00.000Z',
      lastSuccessAt: '2026-05-01T15:00:00.000Z',
    };
    expect(
      computeHealthStatus(recovered, WEDGED_DAEMON_THRESHOLD_MS + 60_000),
    ).toBe(200);
  });

  it('returns 200 right at boot (no failures yet)', () => {
    expect(
      computeHealthStatus(
        {
          ...baseState,
          lastTickAt: null,
          lastSuccessAt: null,
          lastFailAt: null,
        },
        500,
      ),
    ).toBe(200);
  });
});
