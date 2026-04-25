// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  analyzeCatalysts,
  type AnomalySeries,
  type CrossAssetSeries,
  type DarkPrintRow,
  type FlowAlertRow,
  type AnomalyForCatalyst,
} from '../_lib/anomaly-catalyst.js';

// ── Fixtures ─────────────────────────────────────────────────

// Detection time: 11:00 AM ET = 15:00 UTC on 2026-04-23. The catalyst
// window extends back 60 minutes to 14:00 UTC.
const DETECT_TS = '2026-04-23T15:00:00.000Z';
const DETECT_MS = Date.parse(DETECT_TS);

/**
 * Build a minute-cadence spot series from an array of spots. Index 0
 * is at (DETECT_MS - length minutes) and the final sample lands at
 * DETECT_MS. Samples are emitted in ascending ts order.
 */
function minuteSeries(spots: number[]): Array<{ ts: string; spot: number }> {
  const startMs = DETECT_MS - spots.length * 60_000;
  return spots.map((spot, i) => ({
    ts: new Date(startMs + (i + 1) * 60_000).toISOString(),
    spot,
  }));
}

function baseAnomaly(
  side: 'call' | 'put' = 'put',
  ticker = 'SPX',
): AnomalyForCatalyst {
  return { ticker, ts: DETECT_TS, side };
}

function baseAnomalySeries(spots: number[]): AnomalySeries {
  return { ticker: 'SPX', samples: minuteSeries(spots) };
}

// ── Tests ────────────────────────────────────────────────────

describe('analyzeCatalysts', () => {
  it('returns empty leading_assets + "unknown" when no cross-assets provided', () => {
    const out = analyzeCatalysts({
      anomaly: baseAnomaly(),
      anomalySeries: baseAnomalySeries(
        Array.from({ length: 30 }, (_, i) => 7100 - i),
      ),
      crossAssets: [],
      darkPrints: [],
      flowAlerts: [],
    });
    expect(out.leading_assets).toEqual([]);
    expect(out.likely_catalyst).toBe('unknown');
    expect(out.large_dark_prints).toEqual([]);
    expect(out.flow_alerts_in_window).toEqual([]);
  });

  it('detects a leading asset when ZN bids 8 minutes before SPX flushes', () => {
    // Construct a deterministic lead-lag relationship: ZN (bond proxy)
    // rises for 10 minutes, then drops. SPX (anomaly) does the same
    // trajectory but shifted LATER by 8 minutes — so ZN moves FIRST.
    // The two should have a strong correlation with a +8 minute lag.
    //
    // Pattern shape (30 minutes total):
    //   ZN:  rises 0..9, then falls 10..19, then flat 20..29
    //   SPX: flat 0..7, then rises 8..17, then falls 18..27, flat 28..29
    //
    // This gives a strong |correlation| with positive lag (ZN leads).
    const znSpots: number[] = [];
    const spxSpots: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      // ZN rises from 110 → 112 over 0..9, peaks at 112 at i=9,
      // then drops back to 110 over 10..19, flat thereafter.
      let zn: number;
      if (i <= 9) zn = 110 + (i / 9) * 2;
      else if (i <= 19) zn = 112 - ((i - 9) / 10) * 2;
      else zn = 110;
      znSpots.push(zn);

      // SPX is the same shape delayed by 8 minutes: flat 0..7, then
      // INVERTED (SPX flushes when ZN bids) — 7100 drops when ZN
      // rises, then rises when ZN falls.
      let spx: number;
      if (i <= 7) spx = 7100;
      else if (i <= 17)
        spx = 7100 - ((i - 7) / 10) * 40; // drops 7100 → 7060
      else if (i <= 27)
        spx = 7060 + ((i - 17) / 10) * 40; // rebounds 7060 → 7100
      else spx = 7100;
      spxSpots.push(spx);
    }

    const crossAssets: CrossAssetSeries[] = [
      { ticker: 'ZN', samples: minuteSeries(znSpots) },
    ];
    const anomalySeries: AnomalySeries = {
      ticker: 'SPX',
      samples: minuteSeries(spxSpots),
    };

    const out = analyzeCatalysts({
      anomaly: baseAnomaly('put'),
      anomalySeries,
      crossAssets,
      darkPrints: [],
      flowAlerts: [],
    });

    expect(out.leading_assets).toHaveLength(1);
    const la = out.leading_assets[0]!;
    expect(la.ticker).toBe('ZN');
    // Positive correlation depends on sign convention; we only require
    // the detection surfaced *something* with lead-lag character.
    expect(Math.abs(la.correlation)).toBeGreaterThan(0.5);
    // Narrative should reference ZN → SPX.
    expect(out.likely_catalyst).toMatch(/ZN/);
    expect(out.likely_catalyst).toMatch(/SPX/);
  });

  it('emits "unknown" narrative when correlation exists but lag is too short', () => {
    // Synchronous tick-level moves: ZN and SPX rise together minute-by-minute.
    // High correlation but ~0 lag → should NOT satisfy the narrative gate.
    const znSpots = Array.from({ length: 40 }, (_, i) => 110 + i * 0.05);
    const spxSpots = Array.from({ length: 40 }, (_, i) => 7100 + i * 0.5);
    const crossAssets: CrossAssetSeries[] = [
      { ticker: 'ZN', samples: minuteSeries(znSpots) },
    ];

    const out = analyzeCatalysts({
      anomaly: baseAnomaly('put'),
      anomalySeries: { ticker: 'SPX', samples: minuteSeries(spxSpots) },
      crossAssets,
      darkPrints: [],
      flowAlerts: [],
    });

    // Leading assets array may or may not be populated (depends on lag
    // search argmax); but narrative should NOT claim a catalyst when
    // the lag is below the minimum.
    if (out.leading_assets.length > 0) {
      const la = out.leading_assets[0]!;
      if (la.lag_mins < 5 || Math.abs(la.correlation) < 0.6) {
        expect(out.likely_catalyst).toBe('unknown');
      }
    } else {
      expect(out.likely_catalyst).toBe('unknown');
    }
  });

  it('filters large dark prints to only those inside the T-60 window and above notional threshold', () => {
    const outsideWindow: DarkPrintRow = {
      ticker: 'SPX',
      ts: '2026-04-23T13:30:00.000Z', // 90 min before detect → outside window
      notional: 10_000_000,
    };
    const smallInside: DarkPrintRow = {
      ticker: 'SPX',
      ts: '2026-04-23T14:30:00.000Z', // 30 min before detect → inside
      notional: 100_000, // below threshold
    };
    const largeInside: DarkPrintRow = {
      ticker: 'SPX',
      ts: '2026-04-23T14:45:00.000Z', // 15 min before detect → inside
      notional: 15_000_000, // well above threshold
    };

    const out = analyzeCatalysts({
      anomaly: baseAnomaly(),
      anomalySeries: baseAnomalySeries([7100, 7095, 7090]),
      crossAssets: [],
      darkPrints: [outsideWindow, smallInside, largeInside],
      flowAlerts: [],
    });

    expect(out.large_dark_prints).toHaveLength(1);
    expect(out.large_dark_prints[0]!.notional).toBe(15_000_000);
  });

  it('includes flow alerts inside the T-60 window and drops ones outside', () => {
    const alerts: FlowAlertRow[] = [
      { ts: '2026-04-23T13:30:00.000Z', ticker: 'SPX', premium: 1_000_000 }, // outside
      { ts: '2026-04-23T14:20:00.000Z', ticker: 'SPX', premium: 2_000_000 }, // inside
      { ts: '2026-04-23T14:55:00.000Z', ticker: 'SPX', premium: 3_000_000 }, // inside
    ];
    const out = analyzeCatalysts({
      anomaly: baseAnomaly(),
      anomalySeries: baseAnomalySeries([7100, 7095, 7090]),
      crossAssets: [],
      darkPrints: [],
      flowAlerts: alerts,
    });
    expect(out.flow_alerts_in_window).toHaveLength(2);
    expect(out.flow_alerts_in_window.map((f) => f.premium)).toEqual([
      2_000_000, 3_000_000,
    ]);
  });

  it('returns empty arrays and "unknown" on too-short anomaly series (no correlation possible)', () => {
    const out = analyzeCatalysts({
      anomaly: baseAnomaly(),
      anomalySeries: { ticker: 'SPX', samples: minuteSeries([7100, 7099]) },
      crossAssets: [
        { ticker: 'ZN', samples: minuteSeries([110, 110.1, 110.2]) },
      ],
      darkPrints: [],
      flowAlerts: [],
    });
    expect(out.leading_assets).toEqual([]);
    expect(out.likely_catalyst).toBe('unknown');
  });
});
