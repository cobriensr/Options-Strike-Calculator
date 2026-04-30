import { describe, it, expect, beforeEach, vi } from 'vitest';
import { whaleBannerStore } from '../../../components/WhaleAnomalies/banner-store';
import type { WhaleAnomaly } from '../../../components/WhaleAnomalies/types';

function makeWhale(over: Partial<WhaleAnomaly> = {}): WhaleAnomaly {
  return {
    id: 1,
    ticker: 'SPXW',
    option_chain: 'SPXW260429P07150000',
    strike: 7150,
    option_type: 'put',
    expiry: '2026-04-29',
    first_ts: '2026-04-29T16:56:52Z',
    last_ts: '2026-04-29T19:33:07Z',
    detected_at: '2026-04-29T16:57:00Z',
    side: 'BID',
    ask_pct: 0.05,
    total_premium: 12_037_400,
    trade_count: 5,
    vol_oi_ratio: 10.2,
    underlying_price: 7120.12,
    moneyness: 0.0042,
    dte: 0,
    whale_type: 1,
    direction: 'bullish',
    pairing_status: 'sequential',
    source: 'live',
    resolved_at: null,
    hit_target: null,
    pct_to_target: null,
    ...over,
  };
}

describe('whaleBannerStore', () => {
  beforeEach(() => {
    // Reset store state between tests by dismissing any leftovers.
    let entries: { id: number }[] = [];
    const unsub = whaleBannerStore.subscribe((e) => {
      entries = e;
    });
    for (const e of entries) whaleBannerStore.dismiss(e.id);
    unsub();
  });

  it('emits a banner when a whale is pushed', () => {
    const listener = vi.fn();
    const unsub = whaleBannerStore.subscribe(listener);
    listener.mockClear();
    whaleBannerStore.push(makeWhale({ id: 100 }));
    expect(listener).toHaveBeenCalled();
    const lastCall = listener.mock.calls.at(-1)![0];
    expect(lastCall).toHaveLength(1);
    expect(lastCall[0].id).toBe(100);
    unsub();
    whaleBannerStore.dismiss(100);
  });

  it('dedupes by whale id (push with same id is a no-op)', () => {
    const listener = vi.fn();
    const unsub = whaleBannerStore.subscribe(listener);
    listener.mockClear();
    whaleBannerStore.push(makeWhale({ id: 200 }));
    const callsAfterFirst = listener.mock.calls.length;
    whaleBannerStore.push(makeWhale({ id: 200 }));
    expect(listener.mock.calls.length).toBe(callsAfterFirst);
    unsub();
    whaleBannerStore.dismiss(200);
  });

  it('removes the entry on dismiss', () => {
    const listener = vi.fn();
    const unsub = whaleBannerStore.subscribe(listener);
    whaleBannerStore.push(makeWhale({ id: 300 }));
    listener.mockClear();
    whaleBannerStore.dismiss(300);
    expect(listener).toHaveBeenCalled();
    const lastCall = listener.mock.calls.at(-1)![0];
    expect(lastCall.find((e: { id: number }) => e.id === 300)).toBeUndefined();
    unsub();
  });

  it('subscribe immediately delivers the current snapshot', () => {
    whaleBannerStore.push(makeWhale({ id: 400 }));
    const listener = vi.fn();
    const unsub = whaleBannerStore.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 400 })]),
    );
    unsub();
    whaleBannerStore.dismiss(400);
  });
});
