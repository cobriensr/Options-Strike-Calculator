// @vitest-environment node

/**
 * The shared late-flow score (api/_lib/lottery-flow-rescore.ts): the score
 * itself, pinned to the live detector's own computation under any weights it is
 * handed, the seed-live date, and the loader that stops on an unreadable store.
 * The writers that use it (the post-close repair, the owner's re-score, the
 * correction) test their own SQL.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoadLotteryWeights } = vi.hoisted(() => ({
  mockLoadLotteryWeights: vi.fn(),
}));

// The store the weights come from is not reached for real here.
vi.mock('../_lib/lottery-weights-loader.js', () => ({
  loadLotteryWeights: mockLoadLotteryWeights,
}));

import {
  isAlignedFire,
  scoreLotteryV2,
  weekdayOf,
} from '../_lib/lottery-score-weights-v2.js';
import type { LotteryWeights } from '../_lib/lottery-weights-schema.js';
import { SEED_LOTTERY_WEIGHTS } from '../_lib/lottery-weights-seed.js';
import {
  SEED_WEIGHTS_LIVE_FROM,
  loadActive,
  rescoreRow,
  type CandidateRow,
} from '../_lib/lottery-flow-rescore.js';

const SEED_VERSION = 'seed-2026-06-17';

// A later version's weights: the seed with two weights changed, so a row
// scored with it differs from the same row scored with the seed.
const REFIT_WEIGHTS: LotteryWeights = (() => {
  const copy = structuredClone(SEED_LOTTERY_WEIGHTS);
  copy.features.ticker_weights.SNDK =
    (copy.features.ticker_weights.SNDK ?? 0) + 3;
  copy.features.option_type_weights.P += 2;
  return copy;
})();

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: '1',
    date: '2026-11-13',
    underlying_symbol: 'SNDK',
    tod: 'MID',
    dte: 0,
    option_type: 'C',
    trigger_vol_to_oi_window: 0.4,
    gamma_at_trigger: 0.03,
    trigger_ask_pct: 0.8,
    cum_ncp_at_fire: 5_000_000,
    cum_npp_at_fire: 1_000_000,
    score_version: null,
    ...over,
  };
}

// The cron's own computation, copied from detect-lottery-fires.ts Pass 1 on
// purpose: `scoreLotteryV2(active.weights, scoreInput)` with the input built
// from the row's columns. This is what the re-score must stay equal to, under
// whichever weights the active pointer names. If the cron's derivation of
// isAligned or the weekday changes, this copy is the thing to update, and the
// table below then says whether the shared score follows.
function liveScore(weights: LotteryWeights, r: CandidateRow): number | null {
  return scoreLotteryV2(weights, {
    ticker: r.underlying_symbol,
    tod: r.tod as 'MID',
    dte: r.dte,
    volOiWindow: r.trigger_vol_to_oi_window ?? null,
    gammaAtTrigger: r.gamma_at_trigger ?? null,
    triggerAskPct: r.trigger_ask_pct ?? null,
    optionType: r.option_type,
    isAligned: isAlignedFire(
      r.option_type,
      r.cum_ncp_at_fire,
      r.cum_npp_at_fire,
    ),
    dayOfWeek: weekdayOf(r.date),
  });
}

describe('rescoreRow', () => {
  const tickers = ['SNDK', 'TSLA', 'SPY', 'NVDA', 'NOT_IN_THE_WEIGHTS'];
  const tods = ['AM_open', 'MID', 'LUNCH', 'PM'];
  const dates = [
    '2026-11-09',
    '2026-11-10',
    '2026-11-11',
    '2026-11-12',
    '2026-11-13',
  ];
  const cases: CandidateRow[] = [];
  let seq = 0;
  for (const ticker of tickers) {
    for (const tod of tods) {
      for (const dte of [0, 1, 2, 3, 4]) {
        for (const option_type of ['C', 'P'] as const) {
          seq += 1;
          cases.push(
            row({
              id: String(seq),
              underlying_symbol: ticker,
              tod,
              dte,
              option_type,
              date: dates[seq % dates.length]!,
              // Alternate aligned and against-the-flow, and null features.
              cum_ncp_at_fire: seq % 3 === 0 ? 100 : 5_000_000,
              cum_npp_at_fire: seq % 3 === 0 ? 5_000_000 : 100,
              trigger_vol_to_oi_window: seq % 5 === 0 ? null : (seq % 9) / 3,
              gamma_at_trigger: seq % 7 === 0 ? null : (seq % 11) / 200,
              trigger_ask_pct: seq % 4 === 0 ? null : (seq % 10) / 10,
            }),
          );
        }
      }
    }
  }

  // The same grid under two versions' weights: the seed, and a later version
  // whose ticker and option-type weights differ. The score must use the
  // weights it is handed, whichever version they belong to.
  describe.each([
    ['the seed', SEED_LOTTERY_WEIGHTS],
    ['a later version', REFIT_WEIGHTS],
  ])('under the weights of %s', (_label, weights) => {
    it(`equals the live detector's score on all ${cases.length} rows of a grid`, () => {
      expect(cases.length).toBe(200);
      let scored = 0;
      for (const r of cases) {
        const expected = liveScore(weights, r);
        expect(rescoreRow(weights, r), JSON.stringify(r)).toBe(expected);
        if (expected != null) scored += 1;
      }
      // The grid exercises both outcomes.
      expect(scored).toBeGreaterThan(30);
      expect(scored).toBeLessThan(cases.length);
    });
  });

  it('scores a row differently under a later version, so the grid above can tell the weights apart', () => {
    const sndkCall = row();
    const sndkPut = row({
      option_type: 'P',
      cum_ncp_at_fire: 1,
      cum_npp_at_fire: 9,
    });

    expect(rescoreRow(REFIT_WEIGHTS, sndkCall)).toBe(
      (rescoreRow(SEED_LOTTERY_WEIGHTS, sndkCall) as number) + 3,
    );
    expect(rescoreRow(REFIT_WEIGHTS, sndkPut)).toBe(
      (rescoreRow(SEED_LOTTERY_WEIGHTS, sndkPut) as number) + 3 + 2,
    );
  });

  it('gives a fire against the flow, and a tie, no score', () => {
    expect(
      rescoreRow(
        SEED_LOTTERY_WEIGHTS,
        row({ option_type: 'C', cum_ncp_at_fire: 1, cum_npp_at_fire: 9 }),
      ),
    ).toBeNull();
    expect(
      rescoreRow(
        SEED_LOTTERY_WEIGHTS,
        row({ option_type: 'P', cum_ncp_at_fire: 9, cum_npp_at_fire: 1 }),
      ),
    ).toBeNull();
    expect(
      rescoreRow(
        SEED_LOTTERY_WEIGHTS,
        row({ cum_ncp_at_fire: 5, cum_npp_at_fire: 5 }),
      ),
    ).toBeNull();
  });

  it('gives dte beyond 3 no score', () => {
    expect(rescoreRow(SEED_LOTTERY_WEIGHTS, row({ dte: 4 }))).toBeNull();
  });

  it('reports a tod the weights do not know as unscorable, never NaN', () => {
    expect(rescoreRow(SEED_LOTTERY_WEIGHTS, row({ tod: 'PRE_OPEN' }))).toBe(
      'unscorable',
    );
  });
});

describe('SEED_WEIGHTS_LIVE_FROM', () => {
  it('is the first ET trading day after the seed weights went live (2026-09-07 after the close)', () => {
    expect(SEED_WEIGHTS_LIVE_FROM).toBe('2026-09-08');
  });
});

describe('loadActive', () => {
  beforeEach(() => {
    mockLoadLotteryWeights.mockReset();
  });

  it('returns the active version and its weights from a healthy store', async () => {
    const active = { version: 'refit-2026-11-04', weights: REFIT_WEIGHTS };
    mockLoadLotteryWeights.mockResolvedValue({
      active,
      takeit: { version: SEED_VERSION, weights: SEED_LOTTERY_WEIGHTS },
      fallback: null,
    });

    await expect(loadActive()).resolves.toBe(active);
  });

  // The loader answers a store it cannot read with the seed in both slots and
  // says why in `fallback`. Taking that for the active version would score
  // and tag rows with a version the store never named.
  it.each(['transient', 'error'] as const)(
    'throws on a %s fallback, naming the reason',
    async (kind) => {
      mockLoadLotteryWeights.mockResolvedValue({
        active: { version: SEED_VERSION, weights: SEED_LOTTERY_WEIGHTS },
        takeit: { version: SEED_VERSION, weights: SEED_LOTTERY_WEIGHTS },
        fallback: { kind, reason: 'connection lost' },
      });

      await expect(loadActive()).rejects.toThrow(
        `the weights store could not be read (${kind}: connection lost), so the active version is not known. Nothing was read or written.`,
      );
    },
  );

  it('lets a loader that rejects through', async () => {
    mockLoadLotteryWeights.mockRejectedValue(new Error('loader exploded'));

    await expect(loadActive()).rejects.toThrow('loader exploded');
  });
});
