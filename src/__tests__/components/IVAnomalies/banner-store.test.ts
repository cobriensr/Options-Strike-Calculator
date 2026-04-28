import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ivAnomalyBannerStore,
  AUTO_DISMISS_MS,
} from '../../../components/IVAnomalies/banner-store';
import type { IVAnomalyRow } from '../../../components/IVAnomalies/types';

function makeRow(overrides: Partial<IVAnomalyRow> = {}): IVAnomalyRow {
  return {
    id: 1,
    ticker: 'SPXW',
    strike: 7135,
    side: 'put',
    expiry: '2026-04-23',
    spotAtDetect: 7140,
    ivAtDetect: 0.22,
    skewDelta: 2.1,
    zScore: 3.2,
    askMidDiv: 0.6,
    volOiRatio: 48.5,
    sideSkew: 0.78,
    sideDominant: 'ask',
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
    expect(snap.visible[0]?.rowId).toBe(1);
    expect(snap.visible[0]?.kind).toBe('entry');
    expect(snap.overflowCount).toBe(0);
  });

  it('is idempotent — re-pushing the same (id, kind) is a no-op', () => {
    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    expect(ivAnomalyBannerStore.getSnapshot().visible).toHaveLength(1);
  });

  it('allows entry and exit banners for the same row to coexist', () => {
    ivAnomalyBannerStore.push(makeRow({ id: 1 }), { kind: 'entry' });
    ivAnomalyBannerStore.push(makeRow({ id: 1 }), {
      kind: 'exit',
      exitReason: 'iv_regression',
    });
    const snap = ivAnomalyBannerStore.getSnapshot();
    expect(snap.visible).toHaveLength(2);
    expect(snap.visible.map((e) => e.kind).sort()).toEqual(['entry', 'exit']);
  });

  it('tags exit banners with the exitReason', () => {
    ivAnomalyBannerStore.push(makeRow({ id: 1 }), {
      kind: 'exit',
      exitReason: 'bid_side_surge',
    });
    const entry = ivAnomalyBannerStore.getSnapshot().visible[0];
    expect(entry?.kind).toBe('exit');
    expect(entry?.exitReason).toBe('bid_side_surge');
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
    ivAnomalyBannerStore.dismiss('1:entry');
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

    ivAnomalyBannerStore.dismiss('1:entry');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    ivAnomalyBannerStore.push(makeRow({ id: 2 }));
    // No more callbacks after unsubscribe.
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
