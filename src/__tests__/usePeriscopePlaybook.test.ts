/**
 * usePeriscopePlaybook unit tests — Phase 4a of
 * docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md.
 *
 * Mirrors usePeriscopeExposure test patterns: access-mode gating,
 * fetch-on-mount, polling cadence (RTH-only, paused on historical),
 * error paths, unmount-mid-fetch safety, URL construction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { AccessMode } from '../utils/auth';
import type { PlaybookRow } from '../hooks/usePeriscopePlaybook';

vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner' as AccessMode),
}));

import { usePeriscopePlaybook } from '../hooks/usePeriscopePlaybook';
import { getAccessMode } from '../utils/auth';
import { POLL_INTERVALS } from '../constants';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makePlaybookRow(overrides: Partial<PlaybookRow> = {}): PlaybookRow {
  return {
    id: 1,
    mode: 'intraday',
    status: 'complete',
    slotCapturedAt: '2026-05-12T13:30:00Z',
    readTime: '2026-05-12T13:30:00Z',
    spot: 5800,
    panelPayload: {
      spot: 5800,
      cone: { lower: 5780, upper: 5820 },
      longTrigger: 5810,
      shortTrigger: 5790,
      regime: 'drift-and-cap',
      bias: 'two-sided',
      recommended: ['debit_call_spread'],
      avoid: ['iron_condor'],
      futuresPlan: 'LONG: SAFE above 5810',
      gammaFloor: 5780,
      gammaCeiling: 5820,
      magnet: 5800,
      charmZero: 5805,
      expectedDealerBehavior: null,
      confidence: 'medium',
      confidenceBasis: null,
      narrative: 'two-sided regime with...',
    },
    parentId: null,
    model: 'claude-opus-4-7',
    failureReason: null,
    durationMs: 1234,
    createdAt: '2026-05-12T13:30:30Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset();
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Access-mode gating
// ============================================================

describe('usePeriscopePlaybook: access mode', () => {
  it('does not fetch when access mode is public', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    const { result } = renderHook(() =>
      usePeriscopePlaybook({ marketOpen: true }),
    );
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it('fetches when access mode is owner', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-12T13:30:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    renderHook(() => usePeriscopePlaybook({ marketOpen: true }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });

  it('fetches when access mode is guest', async () => {
    vi.mocked(getAccessMode).mockReturnValue('guest');
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-12T13:30:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    renderHook(() => usePeriscopePlaybook({ marketOpen: true }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });
});

// ============================================================
// Successful fetch + state
// ============================================================

describe('usePeriscopePlaybook: successful fetch', () => {
  it('populates data + asOf + latestInProgress + clears emptyReason', async () => {
    const row = makePlaybookRow({ spot: 5777 });
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-12T13:30:00Z',
        data: row,
        latestInProgress: true,
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopePlaybook({ marketOpen: true }),
    );
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.spot).toBe(5777);
    expect(result.current.latestInProgress).toBe(true);
    expect(result.current.asOf).toBe('2026-05-12T13:30:00Z');
    expect(result.current.emptyReason).toBeNull();
  });

  it('surfaces emptyReason=no_playbook + data=null when scraper has nothing yet', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-12T08:00:00Z',
        data: null,
        latestInProgress: false,
        reason: 'no_playbook',
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopePlaybook({ marketOpen: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.emptyReason).toBe('no_playbook');
  });

  it('builds the URL with ?date when selectedDate is set', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: false,
        asOf: '2026-04-15T20:00:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    renderHook(() =>
      usePeriscopePlaybook({
        marketOpen: false,
        selectedDate: '2026-04-15',
      }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('/api/periscope-playbook?date=2026-04-15');
  });

  it('uses the unparameterized URL when on Live', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-12T13:30:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    renderHook(() => usePeriscopePlaybook({ marketOpen: true }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('/api/periscope-playbook');
  });

  it('builds the URL with both ?date and ?slot when pinning a historical slot', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: false,
        asOf: '2026-04-15T20:00:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    renderHook(() =>
      usePeriscopePlaybook({
        marketOpen: false,
        selectedDate: '2026-04-15',
        selectedSlotCapturedAt: '2026-04-15T14:30:00.000Z',
      }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toContain('date=2026-04-15');
    expect(url).toContain('slot=2026-04-15T14%3A30%3A00.000Z');
  });

  it('refetches when selectedSlotCapturedAt changes (prev/next on the panel)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: false,
        asOf: '2026-04-15T20:00:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    const { rerender } = renderHook(
      ({ slot }: { slot: string | null }) =>
        usePeriscopePlaybook({
          marketOpen: false,
          selectedDate: '2026-04-15',
          selectedSlotCapturedAt: slot,
        }),
      {
        initialProps: { slot: '2026-04-15T14:30:00.000Z' as string | null },
      },
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    rerender({ slot: '2026-04-15T14:40:00.000Z' });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const secondCallUrl = mockFetch.mock.calls[1]![0] as string;
    expect(secondCallUrl).toContain('slot=2026-04-15T14%3A40%3A00.000Z');
  });
});

// ============================================================
// Polling cadence
// ============================================================

describe('usePeriscopePlaybook: polling', () => {
  it('polls every PERISCOPE interval during RTH on Live', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-12T13:30:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    renderHook(() => usePeriscopePlaybook({ marketOpen: true }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE);
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does NOT poll outside market hours', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: false,
        asOf: '2026-05-12T22:00:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    renderHook(() => usePeriscopePlaybook({ marketOpen: false }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE * 3);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT poll when viewing a historical date (immutable)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-04-15T20:00:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    renderHook(() =>
      usePeriscopePlaybook({
        marketOpen: true,
        selectedDate: '2026-04-15',
      }),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.PERISCOPE * 3);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Error paths
// ============================================================

describe('usePeriscopePlaybook: error handling', () => {
  it('captures fetch network error to error state', async () => {
    mockFetch.mockRejectedValue(new Error('Network unreachable'));
    const { result } = renderHook(() =>
      usePeriscopePlaybook({ marketOpen: true }),
    );
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toContain('Network unreachable');
    expect(result.current.data).toBeNull();
  });

  it('captures HTTP error to error state', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'bad' }, 500));
    const { result } = renderHook(() =>
      usePeriscopePlaybook({ marketOpen: true }),
    );
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toContain('500');
  });

  it('clears error on subsequent successful refresh', async () => {
    mockFetch.mockRejectedValueOnce(new Error('once-off'));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-12T13:30:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    const { result } = renderHook(() =>
      usePeriscopePlaybook({ marketOpen: true }),
    );
    await waitFor(() => expect(result.current.error).toBeTruthy());
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.data).not.toBeNull();
  });
});

// ============================================================
// Unmount safety
// ============================================================

describe('usePeriscopePlaybook: unmount safety', () => {
  it('does not setState after unmount mid-flight', async () => {
    let resolveFetch!: (value: Response) => void;
    mockFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { result, unmount } = renderHook(() =>
      usePeriscopePlaybook({ marketOpen: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(true));
    unmount();
    // Resolve fetch AFTER unmount — must not crash or warn.
    resolveFetch(
      jsonResponse({
        marketOpen: true,
        asOf: '2026-05-12T13:30:00Z',
        data: makePlaybookRow(),
        latestInProgress: false,
      }),
    );
    await act(async () => {});
    // No assertion needed beyond not throwing — vitest catches setState
    // on unmounted as warnings + React 19 throws.
  });
});
