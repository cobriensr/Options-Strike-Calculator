import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ivAnomalyBannerStore, AUTO_DISMISS_MS } from '../banner-store';
import type { IVAnomalyRow } from '../types';

function makeRow(overrides: Partial<IVAnomalyRow> = {}): IVAnomalyRow {
  return {
    id: 1,
    ticker: 'SPX',
    strike: 7135,
    side: 'put',
    expiry: '2026-04-23',
    spotAtDetect: 7140,
    ivAtDetect: 0.22,
    skewDelta: 2.1,
    zScore: 3.2,
    askMidDiv: 0.6,
    flagReasons: ['skew_delta'],
    flowPhase: 'early',
    contextSnapshot: null,
    resolutionOutcome: null,
    ts: '2026-04-23T15:30:00Z',
    ...overrides,
  };
}

describe('ivAnomalyBannerStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ivAnomalyBannerStore.__resetForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    ivAnomalyBannerStore.__resetForTests();
  });

  it('pushes and exposes a snapshot with the entry', () => {
    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    const snap = ivAnomalyBannerStore.getSnapshot();
    expect(snap.visible).toHaveLength(1);
    expect(snap.visible[0]?.id).toBe(1);
    expect(snap.overflowCount).toBe(0);
  });

  it('is idempotent — re-pushing the same id is a no-op', () => {
    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(1);
  });

  it('stacks up to maxVisible and overflows the rest', () => {
    for (let i = 1; i <= 5; i += 1) {
      ivAnomalyBannerStore.push(makeRow({ id: i }));
    }
    const snap = ivAnomalyBannerStore.getSnapshot();
    expect(snap.visible).toHaveLength(3);
    expect(snap.overflowCount).toBe(2);
  });

  it('auto-dismisses entries after AUTO_DISMISS_MS', () => {
    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(1);
    vi.advanceTimersByTime(AUTO_DISMISS_MS + 10);
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);
  });

  it('dismiss removes the entry immediately and clears its timer', () => {
    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    ivAnomalyBannerStore.dismiss(1);
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);
    // Advancing timers should not re-fire a removed entry.
    vi.advanceTimersByTime(AUTO_DISMISS_MS + 10);
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(0);
  });

  it('notifies subscribers on push and dismiss', () => {
    const listener = vi.fn();
    const unsubscribe = ivAnomalyBannerStore.subscribe(listener);
    // Priming call on subscribe.
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();

    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    expect(listener).toHaveBeenCalledTimes(1);

    ivAnomalyBannerStore.dismiss(1);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    ivAnomalyBannerStore.push(makeRow({ id: 2 }));
    // No more callbacks after unsubscribe.
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
