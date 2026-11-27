import { describe, expect, it } from 'vitest';

import {
  buildLevelLadder,
  candidatesFromDeltas,
  isViewFailed,
  pickLadderSpot,
} from '../components/Gexbot/level-ladder/build';
import { strikeOdds } from '../components/Gexbot/level-ladder/odds';
import {
  STATUS_PILL_LABEL,
  type LadderMarkerRow,
  type LadderStrikeInput,
  type LadderStrikeIv,
  type LadderStrikeRow,
  type LevelLadder,
  type LevelLadderInput,
} from '../components/Gexbot/level-ladder/types';
import type {
  ExpectedMoveRow,
  SnapshotsLatestRow,
} from '../hooks/useGexbotData';
import type { DeltaRow, DeltaRowError } from '../types';

// ────────────────────────────────────────────────────────────
// Fixtures: the spec's sample ladder (spot 7,588.4, E 23.0, call 7,620,
// put 7,555), read at 09:46 CT on 2026-11-25 (CST, UTC−6).
// ────────────────────────────────────────────────────────────

const NOW_ISO = '2026-11-25T15:46:00.000Z';
const NOW = Date.parse(NOW_ISO);
const SPOT = 7588.4;
const SEC = 1000;

/** The sample's levels. The two OI levels are absent unless a test sets them. */
function snapshot(over: Partial<SnapshotsLatestRow> = {}): SnapshotsLatestRow {
  return {
    ticker: 'SPX',
    capturedAt: '2026-11-25T15:45:12.000Z', // 09:45 CT
    spot: 7588.1,
    zeroGamma: 7586.2,
    zMlgamma: 7595,
    zMsgamma: 7580,
    zcvr: null,
    zgr: null,
    zvanna: null,
    zcharm: null,
    oMlgamma: null,
    oMsgamma: null,
    ocvr: null,
    ogr: null,
    ovanna: null,
    ocharm: null,
    oneDexoflow: null,
    oneGexoflow: null,
    oneCvroflow: null,
    zeroMcall: 7600,
    zeroMput: 7570,
    majorPosVol: 7605,
    majorPosOi: null,
    majorNegVol: 7560,
    majorNegOi: null,
    minDte: 0,
    ...over,
  };
}

/** Stamped at now, so `E` is the row's 23.0 exactly. */
function expectedMove(over: Partial<ExpectedMoveRow> = {}): ExpectedMoveRow {
  return {
    ticker: 'SPX',
    capturedAt: NOW_ISO,
    asOf: NOW_ISO,
    spot: 7588.1,
    minDte: 0,
    atmStrike: 7590,
    atmIv: 0.11,
    dteFraction: 0.25,
    expectedMove: 23,
    lower: 7565.1,
    upper: 7611.1,
    unavailable: null,
    ...over,
  };
}

const call = (strike: number): LadderStrikeInput => ({ side: 'call', strike });
const put = (strike: number): LadderStrikeInput => ({ side: 'put', strike });

/**
 * Strike IVs around the sample's two candidates, skewed so the spread price
 * reads both as `watch` where the ATM σ reads them `clear`.
 */
const SAMPLE_IVS: LadderStrikeIv[] = [
  { strike: 7615, callIv: 0.13, putIv: 0.13 },
  { strike: 7620, callIv: 0.129, putIv: 0.129 },
  { strike: 7625, callIv: 0.128, putIv: 0.128 },
  { strike: 7550, callIv: 0.16, putIv: 0.16 },
  { strike: 7555, callIv: 0.158, putIv: 0.158 },
  { strike: 7560, callIv: 0.156, putIv: 0.156 },
];

/** No strike IVs by default, so the odds take the ATM σ as in the sketch. */
function input(over: Partial<LevelLadderInput> = {}): LevelLadderInput {
  return {
    spot: SPOT,
    snapshot: snapshot(),
    expectedMove: expectedMove(),
    strikeIvs: null,
    levelsFailed: false,
    expectedMoveFailed: false,
    candidates: [call(7620), put(7555)],
    openShortStrikes: [],
    nowMs: NOW,
    marketOpen: true,
    ...over,
  };
}

const build = (over: Partial<LevelLadderInput> = {}) =>
  buildLevelLadder(input(over));

/** The ladder as text lines, close to the spec's sketch. */
function lines(ladder: LevelLadder): string[] {
  return ladder.rows.map((r) => {
    if (r.kind === 'marker') {
      return r.detail == null ? `--- ${r.text}` : `--- ${r.text} | ${r.detail}`;
    }
    const parts = [r.strikeText, ...r.chips.map((c) => `[${c.label}]`)];
    if (r.status != null) parts.push(`[${STATUS_PILL_LABEL[r.status]}]`);
    if (r.detail != null) parts.push(r.detail);
    return parts.join(' ');
  });
}

const strikeRows = (l: LevelLadder) =>
  l.rows.filter((r): r is LadderStrikeRow => r.kind === 'strike');
const markerRows = (l: LevelLadder) =>
  l.rows.filter((r): r is LadderMarkerRow => r.kind === 'marker');
const strikes = (l: LevelLadder) => strikeRows(l).map((r) => r.strike);
const rowAt = (l: LevelLadder, strike: number) => {
  const row = strikeRows(l).find((r) => r.strike === strike);
  if (row == null) throw new Error(`no row at ${strike}`);
  return row;
};
const chipLabels = (l: LevelLadder, strike: number) =>
  rowAt(l, strike).chips.map((c) => c.label);
const levelChipCount = (l: LevelLadder) =>
  strikeRows(l).flatMap((r) => r.chips.filter((c) => c.kind === 'level'))
    .length;
const markerTexts = (l: LevelLadder) => markerRows(l).map((m) => m.text);
/** The line just above the row at `strike`. */
const lineAbove = (l: LevelLadder, strike: number) => {
  const idx = l.rows.findIndex(
    (r) => r.kind === 'strike' && r.strike === strike,
  );
  return l.rows[idx - 1];
};

// ────────────────────────────────────────────────────────────

describe('the sample ladder', () => {
  it('lays out every row as the spec sketches it', () => {
    expect(lines(build())).toEqual([
      '7,620 [CANDIDATE · 10Δ CALL] [CLEAR] 1.37σ · touch 17% · finish beyond 8%',
      '7,615',
      '--- +1σ · 7,611.4',
      '7,610',
      '7,605 [Classic major positive · volume] +16.6 pts · inside +1σ',
      '7,600 [State major call] +11.6 pts · inside +1σ',
      '7,595 [State long gamma · taker-long] +6.6 pts · inside +1σ',
      '7,590',
      '--- SPX 7,588.4',
      '--- Classic zero gamma · 7,586.2',
      '7,585',
      '7,580 [State short gamma · taker-short] −8.4 pts · inside −1σ',
      '7,575',
      '7,570 [State major put] −18.4 pts · inside −1σ',
      '--- −1σ · 7,565.4',
      '7,565',
      '7,560 [Classic major negative · volume] −28.4 pts · 5.4 outside −1σ',
      '7,555 [CANDIDATE · 10Δ PUT] [CLEAR] 1.45σ · touch 15% · finish beyond 7%',
    ]);
  });

  it('prints the result line, summaries, levels time and spot', () => {
    const l = build();
    expect(l.result).toEqual({
      kind: 'status',
      pill: 'clear',
      text: 'Both candidate strikes are clear. Call 7,620 is 1.37σ away with a 17% priced chance of a touch. Put 7,555 is 1.45σ away with 15%.',
    });
    expect(l.summary).toEqual({
      call: 'Call 7,620: 31.6 pts above spot, 8.6 outside +1σ. Levels between: 7,595 · 7,600 · 7,605.',
      put: 'Put 7,555: 33.4 pts below spot, 10.4 outside −1σ. Levels between: 7,580 · 7,570 · 7,560.',
    });
    expect(l.levels).toEqual({
      state: 'shown',
      line: null,
      asOfText: '09:45 CT',
    });
    expect(l.spotText).toBe('7,588.4');
    expect(l.band).toEqual({
      expectedMove: 23,
      upper: SPOT + 23,
      lower: SPOT - 23,
    });
    expect(l.above).toEqual({ items: [], text: null });
    expect(l.below).toEqual({ items: [], text: null });
  });

  it('keeps structured odds beside the printed strings', () => {
    const row = rowAt(build(), 7620);
    expect(row.status).toBe('clear');
    expect(row.odds?.sigmaAway).toBeCloseTo(31.6 / 23, 9);
    expect(row.chips[0]).toEqual({
      kind: 'short',
      side: 'call',
      source: 'candidate',
      label: 'CANDIDATE · 10Δ CALL',
    });
  });
});

describe('window', () => {
  it('no band and no short strikes gives the minimum span (±20)', () => {
    const l = build({ expectedMove: null, candidates: [] });
    // 7,588.4 ± 20 = 7,608.4 / 7,568.4, rounded out to strikes.
    expect(strikes(l)[0]).toBe(7610);
    expect(strikes(l).at(-1)).toBe(7565);
    expect(strikes(l)).toHaveLength(10);
  });

  it('every row is a multiple of 5, top to bottom', () => {
    const s = strikes(build());
    for (let i = 1; i < s.length; i++) expect(s[i - 1]! - s[i]!).toBe(5);
  });

  it('reaches to the band plus one strike', () => {
    // E 30: 7,588.4 + 35 = 7,623.4 → 7,625; 7,588.4 − 35 = 7,553.4 → 7,550.
    const l = build({
      expectedMove: expectedMove({ expectedMove: 30 }),
      candidates: [],
    });
    expect(strikes(l)[0]).toBe(7625);
    expect(strikes(l).at(-1)).toBe(7550);
  });

  it('reaches to the short strikes', () => {
    // E 10 gives a band reach of 15, under the minimum; the strikes win.
    const l = build({
      expectedMove: expectedMove({ expectedMove: 10 }),
      candidates: [call(7640), put(7530)],
    });
    expect(strikes(l)[0]).toBe(7640);
    expect(strikes(l).at(-1)).toBe(7530);
    expect(chipLabels(l, 7640)).toEqual(['CANDIDATE · 10Δ CALL']);
    expect(chipLabels(l, 7530)).toEqual(['CANDIDATE · 10Δ PUT']);
  });

  it('caps the reach at ±60 and lists the overflow above and below, nearest first', () => {
    const l = build({
      snapshot: snapshot({ majorPosOi: 7700, majorNegOi: 7450 }),
      expectedMove: expectedMove({ expectedMove: 80 }),
      candidates: [call(7710), put(7470)],
    });
    // 7,588.4 ± 60 = 7,648.4 / 7,528.4 → 7,650 / 7,525.
    expect(strikes(l)[0]).toBe(7650);
    expect(strikes(l).at(-1)).toBe(7525);
    // Both bounds fell outside the window, so only spot and zero gamma remain.
    expect(markerTexts(l)).toEqual([
      'SPX 7,588.4',
      'Classic zero gamma · 7,586.2',
    ]);
    expect(l.above.text).toBe(
      'Above: +1σ 7,668.4; Classic major positive · OI 7,700; Call 7,710 (CLEAR 1.52σ · touch 13% · finish beyond 6%)',
    );
    expect(l.below.text).toBe(
      'Below: −1σ 7,508.4; Put 7,470 (CLEAR 1.48σ · touch 14% · finish beyond 7%); Classic major negative · OI 7,450',
    );
    expect(l.above.items.map((i) => i.kind)).toEqual([
      'bound',
      'level',
      'short',
    ]);
    // A short strike listed there keeps its odds.
    const short = l.above.items[2]!;
    expect(short.status).toBe('clear');
    expect(short.odds?.sigmaAway).toBeCloseTo(121.6 / 80, 9);
    expect(l.above.items[0]!.odds).toBeNull();
  });

  it("prints the spec's overflow line for one level above the window", () => {
    const l = build({ snapshot: snapshot({ majorPosOi: 7700 }) });
    expect(l.above.text).toBe('Above: Classic major positive · OI 7,700');
    expect(l.below.text).toBeNull();
  });
});

describe('chips', () => {
  it('a level on the grid is a chip on its strike', () => {
    const l = build();
    expect(rowAt(l, 7605).chips).toEqual([
      {
        kind: 'level',
        id: 'classic_pos_vol',
        label: 'Classic major positive · volume',
      },
    ]);
  });

  it('two levels on one strike give two chips, in table order', () => {
    // State major call (table row 7) and Classic major positive · volume
    // (row 1) both at 7,600.
    const l = build({ snapshot: snapshot({ majorPosVol: 7600 }) });
    expect(chipLabels(l, 7600)).toEqual([
      'Classic major positive · volume',
      'State major call',
    ]);
    expect(rowAt(l, 7600).detail).toBe('+11.6 pts · inside +1σ');
  });

  it('a level and a short strike on one strike: short chip first, then the odds line', () => {
    const l = build({ snapshot: snapshot({ majorPosVol: 7620 }) });
    expect(chipLabels(l, 7620)).toEqual([
      'CANDIDATE · 10Δ CALL',
      'Classic major positive · volume',
    ]);
    expect(rowAt(l, 7620).status).toBe('clear');
    expect(rowAt(l, 7620).detail).toBe('1.37σ · touch 17% · finish beyond 8%');
  });

  it('untagged rows show the strike alone', () => {
    const row = rowAt(build(), 7615);
    expect(row.chips).toEqual([]);
    expect(row.status).toBeNull();
    expect(row.odds).toBeNull();
    expect(row.detail).toBeNull();
  });
});

describe('markers', () => {
  it('an off-grid strike level is a marker line at its exact value, with its distance', () => {
    const l = build({ snapshot: snapshot({ zMlgamma: 7597.3 }) });
    expect(chipLabels(l, 7595)).toEqual([]);
    expect(lineAbove(l, 7595)).toEqual({
      kind: 'marker',
      marker: 'level',
      levelId: 'state_long_gamma',
      value: 7597.3,
      text: 'State long gamma · taker-long · 7,597.3',
      detail: '+8.9 pts · inside +1σ',
    });
  });

  it('zero gamma on a multiple of 5 is still a marker, not a chip', () => {
    const l = build({ snapshot: snapshot({ zeroGamma: 7585 }) });
    expect(chipLabels(l, 7585)).toEqual([]);
    expect(lineAbove(l, 7585)).toMatchObject({
      marker: 'level',
      levelId: 'classic_zero_gamma',
      text: 'Classic zero gamma · 7,585',
      detail: null,
    });
  });

  it('spot exactly on a strike sits directly above that strike', () => {
    const l = build({ spot: 7590 });
    expect(lineAbove(l, 7590)).toMatchObject({
      marker: 'spot',
      text: 'SPX 7,590.0',
    });
  });

  it('a level exactly at spot reads 0.0 pts, on the +1σ side', () => {
    const l = build({ spot: 7590, snapshot: snapshot({ zeroMcall: 7590 }) });
    expect(rowAt(l, 7590).detail).toBe('0.0 pts · inside +1σ');
  });

  it('a level exactly on a bound is inside it', () => {
    // Spot 7,590 ± 25: the bounds are 7,615 and 7,565.
    const l = build({
      spot: 7590,
      expectedMove: expectedMove({ expectedMove: 25 }),
      snapshot: snapshot({ majorPosVol: 7615, majorNegVol: 7565 }),
    });
    expect(rowAt(l, 7615).detail).toBe('+25.0 pts · inside +1σ');
    expect(rowAt(l, 7565).detail).toBe('−25.0 pts · inside −1σ');
  });

  it('a bound exactly on a strike sits directly above that strike', () => {
    const l = build({
      spot: 7590,
      expectedMove: expectedMove({ expectedMove: 25 }),
    });
    expect(lineAbove(l, 7615)).toMatchObject({
      marker: 'upper',
      text: '+1σ · 7,615.0',
    });
    expect(lineAbove(l, 7565)).toMatchObject({
      marker: 'lower',
      text: '−1σ · 7,565.0',
    });
  });

  it('several between the same two rows sort high to low', () => {
    const l = build({ snapshot: snapshot({ zMsgamma: 7589.1 }) });
    const between = lines(l).slice(
      lines(l).indexOf('7,590') + 1,
      lines(l).indexOf('7,585'),
    );
    expect(between).toEqual([
      '--- State short gamma · taker-short · 7,589.1 | +0.7 pts · inside +1σ',
      '--- SPX 7,588.4',
      '--- Classic zero gamma · 7,586.2',
    ]);
  });
});

describe('absent levels', () => {
  it.each([
    ['null', null],
    ['0', 0],
    ['negative', -7605],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ] as const)('a %s level is absent', (_, value) => {
    const l = build({
      snapshot: snapshot({ majorPosVol: value, zeroGamma: value }),
    });
    expect(chipLabels(l, 7605)).toEqual([]);
    expect(rowAt(l, 7605).detail).toBeNull();
    expect(markerTexts(l)).not.toContain('Classic zero gamma · 7,586.2');
    expect(markerRows(l).some((m) => m.marker === 'level')).toBe(false);
    expect(l.above.items).toEqual([]);
    expect(l.below.items).toEqual([]);
    // The other levels still show.
    expect(chipLabels(l, 7600)).toEqual(['State major call']);
  });
});

describe('usability', () => {
  it('older than the limit with the market open is stale and keeps band and short strikes', () => {
    const l = build({
      snapshot: snapshot({ capturedAt: '2026-11-25T15:39:30.000Z' }), // 390 s
    });
    expect(l.levels).toEqual({
      state: 'stale',
      line: 'GEXBot levels are 6 min old',
      asOfText: '09:39 CT',
    });
    expect(levelChipCount(l)).toBe(0);
    expect(markerTexts(l)).toEqual([
      '+1σ · 7,611.4',
      'SPX 7,588.4',
      '−1σ · 7,565.4',
    ]);
    expect(rowAt(l, 7620).status).toBe('clear');
    expect(rowAt(l, 7555).status).toBe('clear');
    expect(l.band).not.toBeNull();
  });

  it('the limit itself is usable; one second past it is stale (4 min old, rounded down)', () => {
    const at = (ageS: number) =>
      build({
        snapshot: snapshot({
          capturedAt: new Date(NOW - ageS * SEC).toISOString(),
        }),
      }).levels;
    expect(at(240).state).toBe('shown');
    expect(at(241)).toMatchObject({
      state: 'stale',
      line: 'GEXBot levels are 4 min old',
    });
  });

  it('the same age with the market closed is shown', () => {
    const l = build({
      marketOpen: false,
      snapshot: snapshot({ capturedAt: '2026-11-25T15:39:30.000Z' }),
    });
    expect(l.levels.state).toBe('shown');
    expect(l.levels.line).toBeNull();
    expect(chipLabels(l, 7605)).toEqual(['Classic major positive · volume']);
  });

  it('minDte 1 is not_same_day', () => {
    const l = build({ snapshot: snapshot({ minDte: 1 }) });
    expect(l.levels).toEqual({
      state: 'not_same_day',
      line: 'nearest expiry is not same-day',
      asOfText: '09:45 CT',
    });
    expect(levelChipCount(l)).toBe(0);
  });

  it('minDte null is shown', () => {
    expect(build({ snapshot: snapshot({ minDte: null }) }).levels.state).toBe(
      'shown',
    );
  });

  it('no SPX row is missing', () => {
    const l = build({ snapshot: null });
    expect(l.levels).toEqual({
      state: 'missing',
      line: 'No GEXBot levels for SPX in the last 15 min',
      asOfText: null,
    });
    expect(levelChipCount(l)).toBe(0);
    expect(rowAt(l, 7620).status).toBe('clear');
  });

  it('a row with an unreadable capturedAt counts as missing', () => {
    expect(
      build({ snapshot: snapshot({ capturedAt: 'garbage' }) }).levels.state,
    ).toBe('missing');
  });
});

describe('usability precedence', () => {
  it('unavailable beats everything, even with a row passed', () => {
    const l = build({
      levelsFailed: true,
      snapshot: snapshot({ minDte: 1, capturedAt: '2026-11-25T15:00:00Z' }),
    });
    expect(l.levels).toEqual({
      state: 'unavailable',
      line: 'GEXBot levels unavailable',
      asOfText: null,
    });
  });

  it('unavailable, then missing', () => {
    expect(build({ levelsFailed: true, snapshot: null }).levels.state).toBe(
      'unavailable',
    );
    expect(build({ levelsFailed: false, snapshot: null }).levels.state).toBe(
      'missing',
    );
  });

  it('not_same_day beats stale', () => {
    const l = build({
      snapshot: snapshot({
        minDte: 1,
        capturedAt: '2026-11-25T15:39:30.000Z',
      }),
    });
    expect(l.levels.state).toBe('not_same_day');
  });

  it('missing prints its line while open and no line with the market closed', () => {
    expect(build({ snapshot: null }).levels.line).toBe(
      'No GEXBot levels for SPX in the last 15 min',
    );
    expect(build({ snapshot: null, marketOpen: false }).levels).toEqual({
      state: 'missing',
      line: null,
      asOfText: null,
    });
  });
});

describe('strike IVs', () => {
  it("with strikeIvs a short strike's odds come from the spread price", () => {
    const l = build({ strikeIvs: SAMPLE_IVS });
    expect(rowAt(l, 7620).odds?.oddsSource).toBe('spread');
    expect(rowAt(l, 7555).odds?.oddsSource).toBe('spread');
    expect(lines(l)[0]).toBe(
      '7,620 [CANDIDATE · 10Δ CALL] [WATCH] 1.19σ · touch 23% · finish beyond 12%',
    );
    expect(lines(l).at(-1)).toBe(
      '7,555 [CANDIDATE · 10Δ PUT] [WATCH] 1.15σ · touch 25% · finish beyond 13%',
    );
    // Both on watch: the smaller σ is named first.
    expect(l.result).toEqual({
      kind: 'status',
      pill: 'watch',
      text: 'Put 7,555 is on watch: 1.15σ away, a 25% priced chance of a touch and 13% of finishing beyond. Call is on watch.',
    });
  });

  it('with strikeIvs null the odds come from the ATM σ', () => {
    const l = build({ strikeIvs: null });
    expect(rowAt(l, 7620).odds?.oddsSource).toBe('atm');
    expect(rowAt(l, 7620).detail).toBe('1.37σ · touch 17% · finish beyond 8%');
  });

  it('the band is the ATM move either way', () => {
    const withIvs = build({ strikeIvs: SAMPLE_IVS });
    const without = build({ strikeIvs: null });
    expect(withIvs.band).toEqual(without.band);
    expect(markerRows(withIvs)).toEqual(markerRows(without));
    // The summaries measure against that band too.
    expect(withIvs.summary).toEqual(without.summary);
  });

  it('prices with the time left carried forward to now', () => {
    const asOf = new Date(NOW - 200 * SEC).toISOString();
    const l = build({
      strikeIvs: SAMPLE_IVS,
      expectedMove: expectedMove({ asOf }),
    });
    const daysLeft = 0.25 - 200 / 86_400;
    const expected = strikeOdds('call', 7620, SPOT, {
      expectedMove: 23 * Math.sqrt(daysLeft / 0.25),
      daysLeft,
      strikeIvs: SAMPLE_IVS,
    });
    expect(rowAt(l, 7620).odds).toEqual(expected);
  });

  it('no usable expected move means no odds, whatever the strike IVs', () => {
    const l = build({ strikeIvs: SAMPLE_IVS, expectedMove: null });
    expect(rowAt(l, 7620)).toMatchObject({ status: null, odds: null });
    expect(l.result.kind).toBe('no_expected_move');
  });
});

describe('band', () => {
  it('unavailable set gives no band markers, distance-only text and the "Distances only" result', () => {
    const l = build({
      expectedMove: expectedMove({ unavailable: 'no_atm_iv' }),
    });
    expect(l.band).toBeNull();
    expect(markerRows(l).map((m) => m.marker)).toEqual(['spot', 'level']);
    expect(rowAt(l, 7605).detail).toBe('+16.6 pts');
    expect(rowAt(l, 7560).detail).toBe('−28.4 pts');
    expect(rowAt(l, 7620)).toMatchObject({
      status: null,
      odds: null,
      detail: '+31.6 pts',
    });
    expect(rowAt(l, 7555).detail).toBe('−33.4 pts');
    expect(l.result).toEqual({
      kind: 'no_expected_move',
      pill: null,
      text: 'Expected move unavailable. Distances only.',
    });
  });

  it("is centred on the ladder's spot, not the row's lower and upper", () => {
    // GEXBot's spot is 7.6 pts below the ladder's: its lower/upper are too.
    const offRow = expectedMove({
      spot: 7580.8,
      lower: 7557.8,
      upper: 7603.8,
    });
    const l = build({ expectedMove: offRow });
    expect(l.band).toEqual({
      expectedMove: 23,
      upper: SPOT + 23,
      lower: SPOT - 23,
    });
    expect(markerTexts(l)).toContain('+1σ · 7,611.4');
    expect(markerTexts(l)).toContain('−1σ · 7,565.4');
    expect(markerTexts(l)).not.toContain('+1σ · 7,603.8');
    // The status and odds are the same as with a row centred on spot.
    expect(lines(l)).toEqual(lines(build()));
    expect(l.result).toEqual(build().result);
  });

  it('market closed gives no band, odds or status', () => {
    const l = build({ marketOpen: false });
    expect(l.band).toBeNull();
    expect(markerRows(l).map((m) => m.marker)).toEqual(['spot', 'level']);
    expect(rowAt(l, 7620)).toMatchObject({
      status: null,
      odds: null,
      detail: '+31.6 pts',
    });
    expect(l.result.pill).toBeNull();
  });
});

describe('short strikes', () => {
  const deltaRow = (delta: number, callSnapped: number, putSnapped: number) =>
    ({ delta, callSnapped, putSnapped }) as unknown as DeltaRow;
  const errorRow = (delta: number): DeltaRowError =>
    ({ delta, error: 'Strike out of range' }) as DeltaRowError;

  it('candidates come from the 10Δ row of allDeltas', () => {
    expect(
      candidatesFromDeltas([
        deltaRow(5, 7650, 7520),
        deltaRow(10, 7620, 7555),
        deltaRow(15, 7610, 7565),
      ]),
    ).toEqual([call(7620), put(7555)]);
  });

  it('allDeltas null gives no candidates', () => {
    expect(candidatesFromDeltas(null)).toEqual([]);
  });

  it('an error row at 10Δ gives no candidates', () => {
    expect(
      candidatesFromDeltas([deltaRow(5, 7650, 7520), errorRow(10)]),
    ).toEqual([]);
  });

  it('no 10Δ row gives no candidates', () => {
    expect(candidatesFromDeltas([deltaRow(5, 7650, 7520)])).toEqual([]);
  });

  it('a candidate with an unusable strike is dropped', () => {
    expect(candidatesFromDeltas([deltaRow(10, Number.NaN, 7555)])).toEqual([
      put(7555),
    ]);
  });

  it('candidates with an error row show no short chips', () => {
    const l = build({
      candidates: candidatesFromDeltas([errorRow(10)]),
    });
    expect(
      strikeRows(l).some((r) => r.chips.some((c) => c.kind === 'short')),
    ).toBe(false);
    expect(l.result.kind).toBe('no_short_strikes');
  });

  it('open legs hide the candidates', () => {
    const l = build({ openShortStrikes: [call(7625)] });
    const shortChips = strikeRows(l).flatMap((r) =>
      r.chips.filter((c) => c.kind === 'short'),
    );
    expect(shortChips).toEqual([
      {
        kind: 'short',
        side: 'call',
        source: 'open',
        label: 'OPEN · SHORT CALL',
      },
    ]);
    // The hidden put candidate neither stretches the window nor overflows.
    expect(strikes(l).at(-1)).toBe(7560);
    expect(l.below.items).toEqual([]);
    expect(l.result.text).toBe(
      'Short call 7,625 is clear: 1.59σ away, an 11% priced chance of a touch and 6% of finishing beyond. No short put.',
    );
  });

  it('two open short calls use the nearer one in the result, and each gets its chip and odds', () => {
    const l = build({
      spot: 7612.6,
      expectedMove: expectedMove({ expectedMove: 8.1 }),
      openShortStrikes: [call(7640), call(7620), put(7555)],
    });
    expect(l.result).toEqual({
      kind: 'status',
      pill: 'tested',
      text: 'Short call 7,620 is tested: 0.91σ away, a 36% priced chance of a touch and 18% of finishing beyond. Short put is clear.',
    });
    expect(lines(l)[0]).toBe('7,635');
    expect(rowAt(l, 7620).detail).toBe('0.91σ · touch 36% · finish beyond 18%');
    expect(rowAt(l, 7555).detail).toBe(
      '7.1σ · touch under 1% · finish beyond under 1%',
    );
    // The farther call fell outside the window and keeps its odds there.
    expect(l.above.text).toBe(
      'Above: Short call 7,640 (CLEAR 3.4σ · touch under 1% · finish beyond under 1%)',
    );
    expect(l.summary.call).toBe(
      'Short call 7,620: 7.4 pts above spot, 0.7 inside +1σ. No levels between.',
    );
  });

  it('with no expected move, the nearer of two calls leads and the farther overflows with its distance', () => {
    const l = build({
      expectedMove: null,
      openShortStrikes: [call(7700), call(7620)],
    });
    expect(l.summary.call).toBe(
      'Short call 7,620: 31.6 pts above spot. Levels between: 7,595 · 7,600 · 7,605.',
    );
    expect(rowAt(l, 7620).detail).toBe('+31.6 pts');
    expect(l.above.text).toBe('Above: Short call 7,700 (+111.6 pts)');
    expect(l.above.items[0]).toMatchObject({ status: null, odds: null });
  });

  it('two open legs on one strike give one chip', () => {
    const l = build({ openShortStrikes: [call(7620), call(7620)] });
    expect(chipLabels(l, 7620)).toEqual(['OPEN · SHORT CALL']);
  });

  it('an open short strike with an unusable strike is dropped', () => {
    const l = build({ openShortStrikes: [call(Number.NaN)] });
    // Nothing usable is open, so the candidates show.
    expect(chipLabels(l, 7620)).toEqual(['CANDIDATE · 10Δ CALL']);
  });

  it('a call and a put on one strike share a row; the worse one gives the pill', () => {
    const l = build({ openShortStrikes: [call(7590), put(7590)] });
    expect(chipLabels(l, 7590)).toEqual([
      'OPEN · SHORT PUT',
      'OPEN · SHORT CALL',
    ]);
    // Spot 7,588.4 is 1.6 pts past the put and 1.6 pts short of the call.
    expect(rowAt(l, 7590).status).toBe('breached');
    expect(rowAt(l, 7590).detail).toBe('spot is 1.6 pts past it');
    expect(l.result.text).toBe(
      'Short put 7,590 is breached: spot is 1.6 pts past it. Short call is tested.',
    );
  });

  it('an off-grid short strike sits on the nearest listed strike', () => {
    const l = build({ openShortStrikes: [call(7621)] });
    expect(chipLabels(l, 7620)).toEqual(['OPEN · SHORT CALL']);
    expect(l.result.text).toMatch(/^Short call 7,621 is clear: 1\.42σ away/);
  });
});

describe('result line', () => {
  it('both clear (candidates)', () => {
    expect(build().result.text).toBe(
      'Both candidate strikes are clear. Call 7,620 is 1.37σ away with a 17% priced chance of a touch. Put 7,555 is 1.45σ away with 15%.',
    );
  });

  it('both clear (open legs), with the article for an 8%', () => {
    expect(
      build({
        expectedMove: expectedMove({ expectedMove: 23.7 }),
        openShortStrikes: [call(7630), put(7545)],
      }).result,
    ).toEqual({
      kind: 'status',
      pill: 'clear',
      text: 'Both short strikes are clear. Short call 7,630 is 1.76σ away with an 8% priced chance of a touch. Short put 7,545 is 1.83σ away with 7%.',
    });
  });

  it('both clear names the nearer strike in σ first', () => {
    expect(build({ candidates: [call(7625), put(7555)] }).result.text).toBe(
      'Both candidate strikes are clear. Put 7,555 is 1.45σ away with a 15% priced chance of a touch. Call 7,625 is 1.59σ away with 11%.',
    );
  });

  it('one side on watch', () => {
    expect(
      build({
        expectedMove: expectedMove({ expectedMove: 28.7 }),
        candidates: [call(7620), put(7545)],
      }).result,
    ).toEqual({
      kind: 'status',
      pill: 'watch',
      text: 'Call 7,620 is on watch: 1.10σ away, a 27% priced chance of a touch and 14% of finishing beyond. Put is clear.',
    });
  });

  it('one side tested', () => {
    expect(
      build({
        spot: 7612.6,
        expectedMove: expectedMove({ expectedMove: 8.1 }),
        openShortStrikes: [call(7620), put(7555)],
      }).result,
    ).toEqual({
      kind: 'status',
      pill: 'tested',
      text: 'Short call 7,620 is tested: 0.91σ away, a 36% priced chance of a touch and 18% of finishing beyond. Short put is clear.',
    });
  });

  it('breached', () => {
    const l = build({
      spot: 7622.4,
      openShortStrikes: [call(7620), put(7555)],
    });
    expect(l.result).toEqual({
      kind: 'status',
      pill: 'breached',
      text: 'Short call 7,620 is breached: spot is 2.4 pts past it. Short put is clear.',
    });
    expect(rowAt(l, 7620)).toMatchObject({
      status: 'breached',
      detail: 'spot is 2.4 pts past it',
    });
  });

  it('a tie on the worst status names the smaller σ first', () => {
    expect(
      build({
        expectedMove: expectedMove({ expectedMove: 40 }),
        candidates: [call(7620), put(7560)],
      }).result,
    ).toEqual({
      kind: 'status',
      pill: 'tested',
      text: 'Put 7,560 is tested: 0.71σ away, a 48% priced chance of a touch and 24% of finishing beyond. Call is tested.',
    });
  });

  it('one side only', () => {
    expect(build({ openShortStrikes: [call(7620)] }).result).toEqual({
      kind: 'status',
      pill: 'clear',
      text: 'Short call 7,620 is clear: 1.37σ away, a 17% priced chance of a touch and 8% of finishing beyond. No short put.',
    });
  });

  it('one side only, the put side', () => {
    expect(build({ openShortStrikes: [put(7555)] }).result.text).toBe(
      'Short put 7,555 is clear: 1.45σ away, a 15% priced chance of a touch and 7% of finishing beyond. No short call.',
    );
  });

  it('no short strikes, with levels: the nearest strike level each side (zero gamma not counted)', () => {
    expect(build({ candidates: [] }).result).toEqual({
      kind: 'no_short_strikes',
      pill: null,
      text: 'No short strikes to check. Nearest levels: State long gamma · taker-long 7,595 (+6.6 pts) above, State short gamma · taker-short 7,580 (−8.4 pts) below.',
    });
  });

  it('no short strikes, with levels on one side only', () => {
    const l = build({
      candidates: [],
      snapshot: snapshot({
        zMsgamma: null,
        zeroMput: null,
        majorNegVol: null,
      }),
    });
    expect(l.result.text).toBe(
      'No short strikes to check. Nearest levels: State long gamma · taker-long 7,595 (+6.6 pts) above, none below.',
    );
  });

  it('no short strikes, only levels below', () => {
    const l = build({
      candidates: [],
      snapshot: snapshot({
        zMlgamma: null,
        zeroMcall: null,
        majorPosVol: null,
      }),
    });
    expect(l.result.text).toBe(
      'No short strikes to check. Nearest levels: none above, State short gamma · taker-short 7,580 (−8.4 pts) below.',
    );
  });

  it('no short strikes: two levels on the nearest strike name the first in table order', () => {
    const l = build({
      candidates: [],
      snapshot: snapshot({ majorPosVol: 7595 }),
    });
    expect(l.result.text).toBe(
      'No short strikes to check. Nearest levels: Classic major positive · volume 7,595 (+6.6 pts) above, State short gamma · taker-short 7,580 (−8.4 pts) below.',
    );
  });

  it('no short strikes, without levels', () => {
    expect(
      build({ candidates: [], levelsFailed: true, snapshot: null }).result,
    ).toEqual({
      kind: 'no_short_strikes',
      pill: null,
      text: 'No short strikes to check.',
    });
  });

  it('no usable expected move', () => {
    expect(build({ expectedMove: null }).result).toEqual({
      kind: 'no_expected_move',
      pill: null,
      text: 'Expected move unavailable. Distances only.',
    });
  });

  it('market closed', () => {
    expect(build({ marketOpen: false }).result).toEqual({
      kind: 'closed',
      pill: null,
      text: 'Session closed. Levels as of 09:45 CT.',
    });
  });
});

describe('result-line precedence', () => {
  const closeCapture = snapshot({ capturedAt: '2026-11-25T21:01:49.000Z' });
  const evening = Date.parse('2026-11-25T23:30:00.000Z');

  it('closed with the expected move also unavailable prints only the closed line', () => {
    const l = build({
      marketOpen: false,
      nowMs: evening,
      snapshot: closeCapture,
      expectedMove: expectedMove({ unavailable: 'expired' }),
    });
    expect(l.result).toEqual({
      kind: 'closed',
      pill: null,
      text: 'Session closed. Levels as of 15:01 CT.',
    });
  });

  it('no short strikes with no expected move prints only the nearest-levels sentence', () => {
    expect(
      build({ candidates: [], expectedMoveFailed: true, expectedMove: null })
        .result.text,
    ).toBe(
      'No short strikes to check. Nearest levels: State long gamma · taker-long 7,595 (+6.6 pts) above, State short gamma · taker-short 7,580 (−8.4 pts) below.',
    );
  });

  it("the closed line's time comes from capturedAt (21:01:49Z reads 15:01 CT)", () => {
    const l = build({
      marketOpen: false,
      nowMs: evening,
      snapshot: closeCapture,
    });
    expect(l.result.text).toBe('Session closed. Levels as of 15:01 CT.');
    expect(l.levels.asOfText).toBe('15:01 CT');
  });

  it('with no snapshot held, just "Session closed."', () => {
    expect(build({ marketOpen: false, snapshot: null }).result.text).toBe(
      'Session closed.',
    );
    expect(
      build({ marketOpen: false, snapshot: null, levelsFailed: true }).result
        .text,
    ).toBe('Session closed.');
  });

  it('with the market closed and the levels hidden (not same-day), no time is claimed', () => {
    expect(
      build({ marketOpen: false, snapshot: snapshot({ minDte: 1 }) }).result
        .text,
    ).toBe('Session closed.');
  });

  it('with the market closed and short strikes, the closed line still wins', () => {
    const l = build({ marketOpen: false, openShortStrikes: [call(7620)] });
    expect(l.result.kind).toBe('closed');
  });
});

describe('spot (pickLadderSpot)', () => {
  it('a fresh Schwab quote is used', () => {
    expect(
      pickLadderSpot({
        spxSpot: 7588.4,
        spxSpotStale: false,
        gexbotSpot: 7587.9,
        marketOpen: true,
      }),
    ).toEqual({ spot: 7588.4, source: 'schwab', label: 'spot' });
  });

  it('a stale one with the market open falls back to the GEXBot spot', () => {
    expect(
      pickLadderSpot({
        spxSpot: 7588.4,
        spxSpotStale: true,
        gexbotSpot: 7612.1,
        marketOpen: true,
      }),
    ).toEqual({ spot: 7612.1, source: 'gexbot', label: 'GEXBot spot' });
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['NaN', Number.NaN],
  ] as const)('a %s spxSpot falls back the same way', (_, spxSpot) => {
    expect(
      pickLadderSpot({
        spxSpot,
        spxSpotStale: false,
        gexbotSpot: 7612.1,
        marketOpen: true,
      }),
    ).toEqual({ spot: 7612.1, source: 'gexbot', label: 'GEXBot spot' });
  });

  it('with the market closed a stale quote is used as is', () => {
    expect(
      pickLadderSpot({
        spxSpot: 7588.4,
        spxSpotStale: true,
        gexbotSpot: 7612.1,
        marketOpen: false,
      }),
    ).toEqual({ spot: 7588.4, source: 'schwab', label: 'spot' });
  });

  it('with the market closed and no quote, the GEXBot spot', () => {
    expect(
      pickLadderSpot({
        spxSpot: null,
        spxSpotStale: false,
        gexbotSpot: 7612.1,
        marketOpen: false,
      }),
    ).toEqual({ spot: 7612.1, source: 'gexbot', label: 'GEXBot spot' });
  });

  it.each([true, false])(
    'neither spot gives none (market open: %s)',
    (marketOpen) => {
      expect(
        pickLadderSpot({
          spxSpot: null,
          spxSpotStale: false,
          gexbotSpot: null,
          marketOpen,
        }),
      ).toBeNull();
      expect(
        pickLadderSpot({
          spxSpot: 7588.4,
          spxSpotStale: true,
          gexbotSpot: -1,
          marketOpen: true,
        }),
      ).toBeNull();
    },
  );
});

describe('degrading', () => {
  it('expected-move failed gives distances only, with levels kept', () => {
    const l = build({ expectedMoveFailed: true, expectedMove: null });
    expect(l.band).toBeNull();
    expect(l.result.text).toBe('Expected move unavailable. Distances only.');
    expect(l.levels.state).toBe('shown');
    expect(chipLabels(l, 7605)).toEqual(['Classic major positive · volume']);
  });

  it('expected-move failed wins even over a row passed beside it', () => {
    const l = build({ expectedMoveFailed: true });
    expect(l.band).toBeNull();
    expect(l.result.kind).toBe('no_expected_move');
  });

  it('expected-move empty gives distances only, with levels kept', () => {
    const l = build({ expectedMove: null });
    expect(l.band).toBeNull();
    expect(l.result.text).toBe('Expected move unavailable. Distances only.');
    // The sample's six on-grid levels (zero gamma is a marker).
    expect(levelChipCount(l)).toBe(6);
  });

  it.each([
    ['E 0', { expectedMove: 0 }],
    ['no time left', { dteFraction: 0 }],
  ])('a fresh row with no usable move (%s) gives distances only', (_, over) => {
    const l = build({
      expectedMove: expectedMove(over),
      strikeIvs: SAMPLE_IVS,
    });
    expect(l.band).toBeNull();
    expect(rowAt(l, 7620).odds).toBeNull();
    expect(l.result.text).toBe('Expected move unavailable. Distances only.');
  });

  it('an expected-move row with minDte 1 gives no usable expected move', () => {
    // It sizes a later expiry's move from that expiry's IVs and time.
    const l = build({
      expectedMove: expectedMove({ minDte: 1 }),
      strikeIvs: SAMPLE_IVS,
    });
    expect(l.band).toBeNull();
    expect(rowAt(l, 7620)).toMatchObject({ status: null, odds: null });
    expect(l.result).toEqual({
      kind: 'no_expected_move',
      pill: null,
      text: 'Expected move unavailable. Distances only.',
    });
    // The levels are judged on their own row and still show.
    expect(l.levels.state).toBe('shown');
  });

  it('an expected-move row with minDte null is usable', () => {
    const l = build({ expectedMove: expectedMove({ minDte: null }) });
    expect(l.band).toEqual(build().band);
    expect(l.result).toEqual(build().result);
  });

  it('a NaN nowMs gives no band and no status, and still lays out the strikes', () => {
    const l = build({ nowMs: Number.NaN });
    expect(l.band).toBeNull();
    expect(l.result.kind).toBe('no_expected_move');
    expect(rowAt(l, 7620).odds).toBeNull();
    expect(strikes(l).every(Number.isFinite)).toBe(true);
    expect(strikes(l).length).toBeGreaterThan(0);
  });

  it('snapshots-latest failed gives unavailable and no chips, with band and short strikes kept', () => {
    const l = build({ levelsFailed: true, snapshot: null });
    expect(l.levels.state).toBe('unavailable');
    expect(l.levels.line).toBe('GEXBot levels unavailable');
    expect(levelChipCount(l)).toBe(0);
    expect(markerTexts(l)).toEqual([
      '+1σ · 7,611.4',
      'SPX 7,588.4',
      '−1σ · 7,565.4',
    ]);
    expect(rowAt(l, 7620).detail).toBe('1.37σ · touch 17% · finish beyond 8%');
    expect(l.result.kind).toBe('status');
  });

  it('an error with rows held is not a failure', () => {
    expect(isViewFailed({ error: 'HTTP 503', rows: [snapshot()] })).toBe(false);
    expect(isViewFailed({ error: 'HTTP 503', rows: [] })).toBe(true);
    expect(isViewFailed({ error: null, rows: [] })).toBe(false);
  });

  it('fresh held rows still show', () => {
    const levels = { error: 'HTTP 503', rows: [snapshot()] };
    const em = { error: 'HTTP 503', rows: [expectedMove()] };
    const l = build({
      levelsFailed: isViewFailed(levels),
      expectedMoveFailed: isViewFailed(em),
    });
    expect(l.levels.state).toBe('shown');
    expect(l.band).not.toBeNull();
    expect(l.result.kind).toBe('status');
  });

  it('held rows older than the limit age out: stale levels, no usable expected move', () => {
    const old = new Date(NOW - 241 * SEC).toISOString();
    const levels = {
      error: 'HTTP 503',
      rows: [snapshot({ capturedAt: old })],
    };
    const em = {
      error: 'HTTP 503',
      rows: [expectedMove({ asOf: old, capturedAt: old })],
    };
    const l = build({
      snapshot: levels.rows[0]!,
      expectedMove: em.rows[0]!,
      levelsFailed: isViewFailed(levels),
      expectedMoveFailed: isViewFailed(em),
    });
    expect(l.levels.state).toBe('stale');
    expect(l.band).toBeNull();
    expect(l.result.text).toBe('Expected move unavailable. Distances only.');
  });

  it('an expected-move row within the limit is carried forward to now', () => {
    const asOf = new Date(NOW - 200 * SEC).toISOString();
    const l = build({ expectedMove: expectedMove({ asOf }) });
    const e = 23 * Math.sqrt((0.25 - 200 / 86_400) / 0.25);
    expect(l.band?.expectedMove).toBeCloseTo(e, 9);
  });

  it('with the market closed the expected-move age does not matter: there is no band', () => {
    const asOf = new Date(NOW - 10 * 60 * SEC).toISOString();
    expect(
      build({ marketOpen: false, expectedMove: expectedMove({ asOf }) }).band,
    ).toBeNull();
  });
});

describe('summary', () => {
  it('outside the band', () => {
    expect(build().summary.call).toBe(
      'Call 7,620: 31.6 pts above spot, 8.6 outside +1σ. Levels between: 7,595 · 7,600 · 7,605.',
    );
  });

  it('inside the band', () => {
    expect(build({ candidates: [call(7605), put(7555)] }).summary.call).toBe(
      'Call 7,605: 16.6 pts above spot, 6.4 inside +1σ. Levels between: 7,595 · 7,600.',
    );
  });

  it('inside the band, the put side', () => {
    expect(build({ candidates: [call(7620), put(7570)] }).summary.put).toBe(
      'Put 7,570: 18.4 pts below spot, 4.6 inside −1σ. Levels between: 7,580.',
    );
  });

  it('no band', () => {
    expect(build({ expectedMove: null }).summary.call).toBe(
      'Call 7,620: 31.6 pts above spot. Levels between: 7,595 · 7,600 · 7,605.',
    );
  });

  it('breached, with no "Levels between"', () => {
    const l = build({
      spot: 7622.4,
      openShortStrikes: [call(7620), put(7555)],
    });
    expect(l.summary.call).toBe('Short call 7,620: spot is 2.4 pts past it.');
    expect(l.summary.put).toBe(
      'Short put 7,555: 67.4 pts below spot, 44.4 outside −1σ. Levels between: 7,605 · 7,600 · 7,595 · 7,580 · 7,570 · 7,560.',
    );
  });

  it('breached with no band reads the same', () => {
    expect(
      build({
        spot: 7622.4,
        expectedMove: null,
        openShortStrikes: [call(7620)],
      }).summary.call,
    ).toBe('Short call 7,620: spot is 2.4 pts past it.');
  });

  it('spot exactly on the strike is breached: "spot is at it"', () => {
    const l = build({ spot: 7620, openShortStrikes: [call(7620)] });
    expect(l.summary.call).toBe('Short call 7,620: spot is at it.');
    expect(l.result.text).toBe(
      'Short call 7,620 is breached: spot is at it. No short put.',
    );
  });

  it('levels between: nearest first, an off-grid strike level included, zero gamma not', () => {
    const l = build({ snapshot: snapshot({ zMlgamma: 7597.3 }) });
    expect(l.summary.call).toBe(
      'Call 7,620: 31.6 pts above spot, 8.6 outside +1σ. Levels between: 7,597.3 · 7,600 · 7,605.',
    );
    // Zero gamma (7,586.2) lies between spot and the put, and is not listed.
    expect(l.summary.put).toBe(
      'Put 7,555: 33.4 pts below spot, 10.4 outside −1σ. Levels between: 7,580 · 7,570 · 7,560.',
    );
  });

  it('levels between list each distinct price once', () => {
    const l = build({ snapshot: snapshot({ majorPosVol: 7600 }) });
    expect(l.summary.call).toBe(
      'Call 7,620: 31.6 pts above spot, 8.6 outside +1σ. Levels between: 7,595 · 7,600.',
    );
  });

  it('none between', () => {
    expect(build({ candidates: [call(7590), put(7555)] }).summary.call).toBe(
      'Call 7,590: 1.6 pts above spot, 21.4 inside +1σ. No levels between.',
    );
  });

  it('with the levels hidden there is no "Levels between" sentence', () => {
    const l = build({ levelsFailed: true, snapshot: null });
    expect(l.summary.call).toBe(
      'Call 7,620: 31.6 pts above spot, 8.6 outside +1σ.',
    );
  });

  it('a side with no short strike has no summary', () => {
    expect(build({ openShortStrikes: [call(7620)] }).summary.put).toBeNull();
    expect(build({ candidates: [] }).summary).toEqual({
      call: null,
      put: null,
    });
  });
});

describe('null spot', () => {
  it.each([
    ['null', null],
    ['NaN', Number.NaN],
    ['zero', 0],
  ] as const)(
    'a %s spot, with no GEXBot spot either, returns no rows and status no_spot',
    (_, spot) => {
      const l = build({ spot });
      expect(l.rows).toEqual([]);
      expect(l.result).toEqual({ kind: 'no_spot', pill: null, text: '' });
      expect(l.above).toEqual({ items: [], text: null });
      expect(l.below).toEqual({ items: [], text: null });
      expect(l.band).toBeNull();
      expect(l.spotText).toBeNull();
      expect(l.summary).toEqual({ call: null, put: null });
      // The levels are still judged, so a header can say why.
      expect(l.levels.state).toBe('shown');
    },
  );

  it('pickLadderSpot with neither spot feeds the same no_spot ladder', () => {
    const spot = pickLadderSpot({
      spxSpot: null,
      spxSpotStale: false,
      gexbotSpot: null,
      marketOpen: true,
    });
    expect(build({ spot: spot?.spot ?? null }).result.kind).toBe('no_spot');
  });
});
