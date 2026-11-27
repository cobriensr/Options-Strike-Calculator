/**
 * The GEXBot level ladder model: the nine GEXBot levels, the ±1σ band and
 * the short strikes on one SPX strike scale, with every distance, σ, priced
 * probability and status computed and printed here. The component only lays
 * out what `buildLevelLadder` returns.
 *
 * Pure: no clock, no fetch. `nowMs` and `marketOpen` come in as inputs.
 *
 * Spec: docs/superpowers/specs/gexbot-level-ladder-2026-11-22.md,
 * "Ladder rules".
 */

import { DEFAULTS } from '../../../constants';
import type { SnapshotsLatestRow } from '../../../hooks/useGexbotData';
import type { DeltaRow, DeltaRowError } from '../../../types';
import { getCTTime } from '../../../utils/timezone';
import {
  carryForwardMove,
  formatOddsLine,
  formatOneDecimal,
  formatPercent,
  formatPointsPast,
  formatSigma,
  isPositiveFinite,
  strikeOdds,
} from './odds';
import {
  LADDER_LEVELS,
  LADDER_MAX_HALF_SPAN_PTS,
  LADDER_MAX_LEVEL_AGE_SECONDS,
  LADDER_MIN_HALF_SPAN_PTS,
  LADDER_SHORT_DELTA,
  STATUS_PILL_LABEL,
  type LadderBand,
  type LadderChip,
  type LadderEdge,
  type LadderEdgeItem,
  type LadderLevelDef,
  type LadderLevels,
  type LadderLevelsState,
  type LadderMarkerRow,
  type LadderResult,
  type LadderRow,
  type LadderSpot,
  type LadderStrikeInput,
  type LadderStrikeRow,
  type LadderVolatility,
  type LevelLadder,
  type LevelLadderInput,
  type ShortSide,
  type ShortSource,
  type StrikeOdds,
  type StrikeStatus,
} from './types';

const STEP = DEFAULTS.STRIKE_INCREMENT;

const MISSING_LINE = 'No GEXBot levels for SPX in the last 15 min';

const RESULT_LABEL: Record<ShortSource, Record<ShortSide, string>> = {
  candidate: { call: 'Call', put: 'Put' },
  open: { call: 'Short call', put: 'Short put' },
};

const CHIP_LABEL: Record<ShortSource, Record<ShortSide, string>> = {
  candidate: {
    call: `CANDIDATE · ${LADDER_SHORT_DELTA}Δ CALL`,
    put: `CANDIDATE · ${LADDER_SHORT_DELTA}Δ PUT`,
  },
  open: { call: 'OPEN · SHORT CALL', put: 'OPEN · SHORT PUT' },
};

/** The status as a sentence says it: "is on watch", "is tested". */
const STATUS_WORD: Record<StrikeStatus, string> = {
  clear: 'clear',
  watch: 'on watch',
  tested: 'tested',
  breached: 'breached',
};

const SEVERITY: Record<StrikeStatus, number> = {
  clear: 0,
  watch: 1,
  tested: 2,
  breached: 3,
};

// ────────────────────────────────────────────────────────────
// Inputs: spot, candidates, failed views
// ────────────────────────────────────────────────────────────

/**
 * The ladder's spot. While the market is open a Schwab quote counts only
 * when it is not stale (`useQuoteStaleness`'s `isStale`): a lapsed login
 * keeps the last quote, which would freeze the ladder. A null, unusable or
 * stale quote falls back to the expected-move row's spot, "GEXBot spot".
 * With the market closed the held quote is the close and is used as is.
 */
export function pickLadderSpot(input: {
  spxSpot: number | null;
  spxSpotStale: boolean;
  gexbotSpot: number | null;
  marketOpen: boolean;
}): LadderSpot | null {
  const { spxSpot, spxSpotStale, gexbotSpot, marketOpen } = input;
  if (isPositiveFinite(spxSpot) && !(marketOpen && spxSpotStale)) {
    return { spot: spxSpot, source: 'schwab', label: 'spot' };
  }
  if (isPositiveFinite(gexbotSpot)) {
    return { spot: gexbotSpot, source: 'gexbot', label: 'GEXBot spot' };
  }
  return null;
}

/**
 * The calculator's candidates: the `LADDER_SHORT_DELTA` row's snapped call
 * and put. Null `allDeltas`, no such row, or an error row give none.
 */
export function candidatesFromDeltas(
  allDeltas: ReadonlyArray<DeltaRow | DeltaRowError> | null,
): LadderStrikeInput[] {
  const row = allDeltas?.find((r) => r.delta === LADDER_SHORT_DELTA);
  if (row == null || 'error' in row) return [];
  return usableStrikes([
    { side: 'call', strike: row.callSnapped },
    { side: 'put', strike: row.putSnapped },
  ]);
}

/**
 * A failed view: its `useGexbotData` hook has `error` set and holds no rows.
 * The hook keeps the last good rows beside a later error, and those are
 * judged by their age instead, so one blip changes nothing on screen.
 */
export function isViewFailed(view: {
  error: string | null;
  rows: readonly unknown[];
}): boolean {
  return view.error != null && view.rows.length === 0;
}

/** Drops strikes that are null-like or ≤ 0, and repeats of a side + strike. */
function usableStrikes(
  strikes: readonly LadderStrikeInput[],
): LadderStrikeInput[] {
  const seen = new Set<string>();
  return strikes.filter((s) => {
    const key = `${s.side}:${s.strike}`;
    if (!isPositiveFinite(s.strike) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ────────────────────────────────────────────────────────────
// Grid and printing helpers
// ────────────────────────────────────────────────────────────

// Exact arithmetic, no tolerance: the window's short-strike edges are the
// strikes themselves, a sum of one- or two-decimal prices near SPX levels
// lands exactly on the strike it should (probed over 7,580 to 7,620), and a
// vendor level on the grid arrives as a whole number.
const isOnGrid = (price: number) => Number.isInteger(price / STEP);
const snapToStrike = (price: number) => Math.round(price / STEP) * STEP;
const ceilToStrike = (price: number) => Math.ceil(price / STEP) * STEP;
const floorToStrike = (price: number) => Math.floor(price / STEP) * STEP;

/** A strike or level price: "7,620", or "7,586.2" off a whole number. */
function formatPrice(price: number): string {
  const tenths = Math.round(price * 10) / 10;
  return Number.isInteger(tenths)
    ? tenths.toLocaleString('en-US')
    : formatOneDecimal(tenths);
}

/** "+16.6 pts", "−8.4 pts" (U+2212), "0.0 pts". */
function formatSignedPoints(points: number): string {
  const text = formatOneDecimal(Math.abs(points));
  if (text === '0.0') return '0.0 pts';
  return `${points > 0 ? '+' : '−'}${text} pts`;
}

/** 24-hour CT clock time: "15:01 CT". */
function formatClockCT(ms: number): string {
  const { hour, minute } = getCTTime(new Date(ms));
  const hh = String(hour % 24).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${hh}:${mm} CT`;
}

/** "a 17%", "an 8%", "an 11%", "an 18%", "an under 1%". */
function withArticle(percentText: string): string {
  const article = /^(?:8|11%|18%|under|over)/.test(percentText) ? 'an' : 'a';
  return `${article} ${percentText}`;
}

// ────────────────────────────────────────────────────────────
// Levels
// ────────────────────────────────────────────────────────────

/**
 * A row for the same-day expiry: `minDte` 0, or null (not reported). The
 * levels and the expected move both need it.
 */
const isSameDay = (minDte: number | null) => minDte == null || minDte === 0;

interface ShownLevel {
  def: LadderLevelDef;
  value: number;
}

/**
 * Whether the snapshot's levels show and, if not, the one line that says
 * why. The first that applies wins: `unavailable`, `missing`,
 * `not_same_day`, `stale`. Age counts only while the market is open; with
 * it closed the last levels stay, labelled with their time.
 */
function judgeLevels(
  snapshot: SnapshotsLatestRow | null,
  failed: boolean,
  nowMs: number,
  marketOpen: boolean,
): { levels: LadderLevels; shown: ShownLevel[] } {
  const hidden = (
    state: LadderLevelsState,
    line: string | null,
    asOfText: string | null = null,
  ) => ({ levels: { state, line, asOfText }, shown: [] });

  if (failed) return hidden('unavailable', 'GEXBot levels unavailable');
  const capturedMs =
    snapshot == null ? Number.NaN : Date.parse(snapshot.capturedAt);
  // An unreadable stamp can't be aged, so the row counts as no row.
  if (snapshot == null || Number.isNaN(capturedMs)) {
    return hidden('missing', marketOpen ? MISSING_LINE : null);
  }
  const asOfText = formatClockCT(capturedMs);
  if (!isSameDay(snapshot.minDte)) {
    return hidden('not_same_day', 'nearest expiry is not same-day', asOfText);
  }
  const ageSeconds = (nowMs - capturedMs) / 1000;
  if (marketOpen && ageSeconds > LADDER_MAX_LEVEL_AGE_SECONDS) {
    const minutes = Math.floor(ageSeconds / 60);
    return hidden('stale', `GEXBot levels are ${minutes} min old`, asOfText);
  }
  const shown = LADDER_LEVELS.flatMap((def) => {
    const value = snapshot[def.field];
    return isPositiveFinite(value) ? [{ def, value }] : [];
  });
  return { levels: { state: 'shown', line: null, asOfText }, shown };
}

/**
 * What the odds are priced from, while the expected move is usable: the
 * market open, the view not failed, a same-day row (`minDte` 0 or null, the
 * levels' test: a later expiry's move is sized from that expiry's IVs and
 * time) with no `unavailable` reason whose `asOf` is within the age limit,
 * carried forward to now with `E` above 0. The strike IVs ride along;
 * without a usable move there are no odds at all.
 */
function usableVolatility(input: LevelLadderInput): LadderVolatility | null {
  const row = input.expectedMove;
  if (
    !input.marketOpen ||
    input.expectedMoveFailed ||
    row == null ||
    row.unavailable != null ||
    !isSameDay(row.minDte)
  ) {
    return null;
  }
  const ageSeconds = (input.nowMs - Date.parse(row.asOf)) / 1000;
  if (ageSeconds > LADDER_MAX_LEVEL_AGE_SECONDS) return null;
  const carried = carryForwardMove(row, input.nowMs);
  return carried == null ? null : { ...carried, strikeIvs: input.strikeIvs };
}

// ────────────────────────────────────────────────────────────
// Short strikes
// ────────────────────────────────────────────────────────────

interface ShortView {
  side: ShortSide;
  strike: number;
  source: ShortSource;
  /** "Call" / "Short call". */
  label: string;
  /** Points from spot toward the money; ≤ 0 means at or past the strike. */
  toward: number;
  odds: StrikeOdds | null;
  /** The second column: the odds line, or the signed distance without odds. */
  detail: string;
}

type RatedShort = ShortView & { odds: StrikeOdds };

const isRated = (v: ShortView | undefined): v is RatedShort => v?.odds != null;

/**
 * Most exposed first: the worse status, then the smaller σ (the spec's tie
 * rule; the priced chance can rank two strikes apart from their distance),
 * or the smaller distance when there are no odds.
 */
function byExposure(a: ShortView, b: ShortView): number {
  if (a.odds == null || b.odds == null) return a.toward - b.toward;
  const severity = SEVERITY[b.odds.status] - SEVERITY[a.odds.status];
  return severity !== 0 ? severity : a.odds.sigmaAway - b.odds.sigmaAway;
}

function shortViews(
  input: LevelLadderInput,
  spot: number,
  vol: LadderVolatility | null,
): ShortView[] {
  const open = usableStrikes(input.openShortStrikes);
  // While any open short leg exists, the candidates are hidden.
  const source: ShortSource = open.length > 0 ? 'open' : 'candidate';
  const strikes = open.length > 0 ? open : usableStrikes(input.candidates);
  return strikes.map(({ side, strike }) => {
    const odds = strikeOdds(side, strike, spot, vol);
    return {
      side,
      strike,
      source,
      label: RESULT_LABEL[source][side],
      toward: side === 'call' ? strike - spot : spot - strike,
      odds,
      detail:
        odds == null ? formatSignedPoints(strike - spot) : formatOddsLine(odds),
    };
  });
}

/**
 * The short strike the result line and summary name on one side: the most
 * exposed, which is the nearest to spot unless one is already breached.
 */
function sideLead(
  views: readonly ShortView[],
  side: ShortSide,
): ShortView | undefined {
  return views.filter((v) => v.side === side).sort(byExposure)[0];
}

// ────────────────────────────────────────────────────────────
// Window, rows, markers, edges
// ────────────────────────────────────────────────────────────

/**
 * Each way the window reaches the largest of the minimum span, the band's
 * bound plus one strike and the nearest short strike that side, capped at
 * the maximum span, then rounded out to a strike.
 */
function windowBounds(
  spot: number,
  band: LadderBand | null,
  views: readonly ShortView[],
): { top: number; bottom: number } {
  const ups = [spot + LADDER_MIN_HALF_SPAN_PTS];
  const downs = [spot - LADDER_MIN_HALF_SPAN_PTS];
  if (band != null) {
    ups.push(band.upper + STEP);
    downs.push(band.lower - STEP);
  }
  const calls = views.filter((v) => v.side === 'call' && v.strike > spot);
  const puts = views.filter((v) => v.side === 'put' && v.strike < spot);
  if (calls.length > 0) ups.push(Math.min(...calls.map((v) => v.strike)));
  if (puts.length > 0) downs.push(Math.max(...puts.map((v) => v.strike)));
  return {
    top: ceilToStrike(
      Math.min(spot + LADDER_MAX_HALF_SPAN_PTS, Math.max(...ups)),
    ),
    bottom: floorToStrike(
      Math.max(spot - LADDER_MAX_HALF_SPAN_PTS, Math.min(...downs)),
    ),
  };
}

/** A row's position against the band: "inside +1σ", "5.4 outside −1σ". */
function bandPosition(price: number, spot: number, band: LadderBand): string {
  if (price >= spot) {
    return price <= band.upper
      ? 'inside +1σ'
      : `${formatOneDecimal(price - band.upper)} outside +1σ`;
  }
  return price >= band.lower
    ? 'inside −1σ'
    : `${formatOneDecimal(band.lower - price)} outside −1σ`;
}

/** A level's second column: "+16.6 pts · inside +1σ", or the distance. */
function levelDetail(
  price: number,
  spot: number,
  band: LadderBand | null,
): string {
  const distance = formatSignedPoints(price - spot);
  return band == null
    ? distance
    : `${distance} · ${bandPosition(price, spot, band)}`;
}

/**
 * One strike row: short-strike chips first (most exposed first), then level
 * chips in table order. The second column is the most exposed short
 * strike's odds line, else the level's distance, else nothing.
 */
function strikeRow(
  strike: number,
  shortsHere: readonly ShortView[] | undefined,
  levelsHere: readonly ShownLevel[] | undefined,
  spot: number,
  band: LadderBand | null,
): LadderStrikeRow {
  const shorts = [...(shortsHere ?? [])].sort(byExposure);
  const levels = levelsHere ?? [];
  const chips: LadderChip[] = [
    ...shorts.map(
      (v): LadderChip => ({
        kind: 'short',
        side: v.side,
        source: v.source,
        label: CHIP_LABEL[v.source][v.side],
      }),
    ),
    ...levels.map(
      (l): LadderChip => ({ kind: 'level', id: l.def.id, label: l.def.label }),
    ),
  ];
  const lead = shorts[0];
  let detail: string | null = null;
  if (lead != null) detail = lead.detail;
  else if (levels.length > 0) detail = levelDetail(strike, spot, band);
  return {
    kind: 'strike',
    strike,
    strikeText: formatPrice(strike),
    chips,
    status: lead?.odds?.status ?? null,
    odds: lead?.odds ?? null,
    detail,
  };
}

function shortEdgeItem(v: ShortView): LadderEdgeItem {
  const inner =
    v.odds == null
      ? v.detail
      : `${STATUS_PILL_LABEL[v.odds.status]} ${v.detail}`;
  return {
    kind: 'short',
    value: v.strike,
    text: `${v.label} ${formatPrice(v.strike)} (${inner})`,
    status: v.odds?.status ?? null,
    odds: v.odds,
  };
}

function plainEdgeItem(
  kind: 'level' | 'bound',
  value: number,
  text: string,
): LadderEdgeItem {
  return { kind, value, text, status: null, odds: null };
}

function edge(side: 'Above' | 'Below', items: LadderEdgeItem[]): LadderEdge {
  return {
    items,
    text:
      items.length > 0
        ? `${side}: ${items.map((i) => i.text).join('; ')}`
        : null,
  };
}

/** Get-or-create on a map of per-strike arrays. */
function bucket<T>(map: Map<number, T[]>, key: number): T[] {
  let items = map.get(key);
  if (items == null) {
    items = [];
    map.set(key, items);
  }
  return items;
}

/**
 * Rows top to bottom. A short strike or on-grid strike level inside the
 * window is a chip on its strike; spot, the bounds, zero gamma and off-grid
 * levels inside it are markers, each directly above the first row at or
 * below its value (several there sort high to low); anything outside goes
 * to `above` or `below`, nearest first.
 */
function layOut(
  spot: number,
  band: LadderBand | null,
  views: readonly ShortView[],
  shown: readonly ShownLevel[],
): { rows: LadderRow[]; above: LadderEdge; below: LadderEdge } {
  const { top, bottom } = windowBounds(spot, band, views);
  const inWindow = (price: number) => price >= bottom && price <= top;
  const shortsAt = new Map<number, ShortView[]>();
  const levelsAt = new Map<number, ShownLevel[]>();
  const markersAt = new Map<number, LadderMarkerRow[]>();
  const outside: LadderEdgeItem[] = [];
  const addMarker = (row: Omit<LadderMarkerRow, 'kind'>) =>
    bucket(markersAt, floorToStrike(row.value)).push({
      kind: 'marker',
      ...row,
    });

  addMarker({
    marker: 'spot',
    levelId: null,
    value: spot,
    text: `SPX ${formatOneDecimal(spot)}`,
    detail: null,
  });
  if (band != null) {
    const bounds = [
      ['upper', band.upper, '+1σ'],
      ['lower', band.lower, '−1σ'],
    ] as const;
    for (const [marker, value, label] of bounds) {
      const price = formatOneDecimal(value);
      if (inWindow(value)) {
        addMarker({
          marker,
          levelId: null,
          value,
          text: `${label} · ${price}`,
          detail: null,
        });
      } else {
        outside.push(plainEdgeItem('bound', value, `${label} ${price}`));
      }
    }
  }
  for (const level of shown) {
    const { def, value } = level;
    const isStrike = def.kind === 'strike';
    const isChip = isStrike && isOnGrid(value);
    const place = isChip ? snapToStrike(value) : value;
    if (!inWindow(place)) {
      outside.push(
        plainEdgeItem('level', value, `${def.label} ${formatPrice(value)}`),
      );
    } else if (isChip) {
      bucket(levelsAt, place).push(level);
    } else {
      addMarker({
        marker: 'level',
        levelId: def.id,
        value,
        text: `${def.label} · ${formatPrice(value)}`,
        detail: isStrike ? levelDetail(value, spot, band) : null,
      });
    }
  }
  for (const v of views) {
    const row = snapToStrike(v.strike);
    if (inWindow(row)) bucket(shortsAt, row).push(v);
    else outside.push(shortEdgeItem(v));
  }

  const rows: LadderRow[] = [];
  for (let strike = top; strike >= bottom; strike -= STEP) {
    const markers = markersAt.get(strike) ?? [];
    rows.push(
      ...markers.sort((a, b) => b.value - a.value),
      strikeRow(strike, shortsAt.get(strike), levelsAt.get(strike), spot, band),
    );
  }

  const above = outside
    .filter((i) => i.value > top)
    .sort((a, b) => a.value - b.value);
  const below = outside
    .filter((i) => i.value <= top)
    .sort((a, b) => b.value - a.value);
  return { rows, above: edge('Above', above), below: edge('Below', below) };
}

// ────────────────────────────────────────────────────────────
// Result line and summary
// ────────────────────────────────────────────────────────────

const name = (v: ShortView) => `${v.label} ${formatPrice(v.strike)}`;

/** "Short call 7,620 is tested: 0.91σ away, a 36% priced chance …". */
function statusSentence(v: RatedShort): string {
  const { odds } = v;
  if (odds.status === 'breached') {
    return `${name(v)} is breached: ${formatPointsPast(odds.pointsPast)}.`;
  }
  const touch = withArticle(formatPercent(odds.touch));
  const finish = formatPercent(odds.finishBeyond);
  return `${name(v)} is ${STATUS_WORD[odds.status]}: ${formatSigma(odds.sigmaAway)} away, ${touch} priced chance of a touch and ${finish} of finishing beyond.`;
}

/**
 * The status sentences, worst first: both sides clear as one pair, or the
 * worst strike in full and the other side by its status word (or its
 * absence). On a tie the smaller σ is named first.
 */
function statusResult(
  worst: RatedShort,
  other: RatedShort | undefined,
): LadderResult {
  const pill = worst.odds.status;
  // Both sides share one source: open legs hide the candidates.
  const { source } = worst;
  if (other?.odds.status === 'clear' && worst.odds.status === 'clear') {
    const lead =
      source === 'open'
        ? 'Both short strikes are clear.'
        : 'Both candidate strikes are clear.';
    const firstTouch = withArticle(formatPercent(worst.odds.touch));
    const first = `${name(worst)} is ${formatSigma(worst.odds.sigmaAway)} away with ${firstTouch} priced chance of a touch.`;
    const second = `${name(other)} is ${formatSigma(other.odds.sigmaAway)} away with ${formatPercent(other.odds.touch)}.`;
    return { kind: 'status', pill, text: `${lead} ${first} ${second}` };
  }
  const missingSide: ShortSide = worst.side === 'call' ? 'put' : 'call';
  const tail =
    other == null
      ? `No ${RESULT_LABEL[source][missingSide].toLowerCase()}.`
      : `${other.label} is ${STATUS_WORD[other.odds.status]}.`;
  return { kind: 'status', pill, text: `${statusSentence(worst)} ${tail}` };
}

/** "No short strikes to check. Nearest levels: … above, … below." */
function nearestLevelsSentence(
  shown: readonly ShownLevel[],
  spot: number,
): string {
  const strikeLevels = shown.filter((l) => l.def.kind === 'strike');
  if (strikeLevels.length === 0) return 'No short strikes to check.';
  // Stable sort: two levels at the same price keep table order.
  const nearest = (above: boolean) =>
    strikeLevels
      .filter((l) => (above ? l.value >= spot : l.value < spot))
      .sort((a, b) => Math.abs(a.value - spot) - Math.abs(b.value - spot))[0];
  const part = (level: ShownLevel | undefined, side: 'above' | 'below') => {
    if (level == null) return `none ${side}`;
    const distance = formatSignedPoints(level.value - spot);
    return `${level.def.label} ${formatPrice(level.value)} (${distance}) ${side}`;
  };
  return `No short strikes to check. Nearest levels: ${part(nearest(true), 'above')}, ${part(nearest(false), 'below')}.`;
}

/** Strike levels strictly between spot and the strike, nearest first, each price once. */
function levelsBetween(
  v: ShortView,
  spot: number,
  shown: readonly ShownLevel[],
): string[] {
  const low = Math.min(spot, v.strike);
  const high = Math.max(spot, v.strike);
  const prices = shown
    .filter((l) => l.def.kind === 'strike' && l.value > low && l.value < high)
    .sort((a, b) => Math.abs(a.value - spot) - Math.abs(b.value - spot))
    .map((l) => formatPrice(l.value));
  return [...new Set(prices)];
}

/**
 * One side's summary: "Call 7,620: 31.6 pts above spot, 8.6 outside +1σ.
 * Levels between: 7,595 · 7,600 · 7,605." With no band, distance only; once
 * breached, how far past it spot is. With the levels hidden there is no
 * "Levels between" sentence, which would otherwise read as none.
 */
function summaryLine(
  v: ShortView | undefined,
  spot: number,
  band: LadderBand | null,
  shown: readonly ShownLevel[] | null,
): string | null {
  if (v == null) return null;
  if (v.toward <= 0) {
    return `${name(v)}: ${formatPointsPast(Math.abs(v.toward))}.`;
  }
  const isCall = v.side === 'call';
  let text = `${name(v)}: ${formatOneDecimal(v.toward)} pts ${isCall ? 'above' : 'below'} spot`;
  if (band != null) {
    const bound = isCall ? '+1σ' : '−1σ';
    const beyond = isCall ? v.strike - band.upper : band.lower - v.strike;
    text +=
      beyond > 0
        ? `, ${formatOneDecimal(beyond)} outside ${bound}`
        : `, ${formatOneDecimal(Math.abs(beyond))} inside ${bound}`;
  }
  text += '.';
  if (shown == null) return text;
  const between = levelsBetween(v, spot, shown);
  return between.length > 0
    ? `${text} Levels between: ${between.join(' · ')}.`
    : `${text} No levels between.`;
}

// ────────────────────────────────────────────────────────────
// The model
// ────────────────────────────────────────────────────────────

const NO_EDGE: LadderEdge = { items: [], text: null };

export function buildLevelLadder(input: LevelLadderInput): LevelLadder {
  const { levels, shown } = judgeLevels(
    input.snapshot,
    input.levelsFailed,
    input.nowMs,
    input.marketOpen,
  );
  if (!isPositiveFinite(input.spot)) {
    return {
      result: { kind: 'no_spot', pill: null, text: '' },
      rows: [],
      above: NO_EDGE,
      below: NO_EDGE,
      levels,
      band: null,
      spotText: null,
      summary: { call: null, put: null },
    };
  }
  const spot = input.spot;
  const vol = usableVolatility(input);
  // The band is the ATM move whatever prices the odds.
  const band: LadderBand | null =
    vol == null
      ? null
      : {
          expectedMove: vol.expectedMove,
          upper: spot + vol.expectedMove,
          lower: spot - vol.expectedMove,
        };
  const views = shortViews(input, spot, vol);
  const lead = { call: sideLead(views, 'call'), put: sideLead(views, 'put') };
  const { rows, above, below } = layOut(spot, band, views, shown);

  let result: LadderResult;
  const [worst, other] = [lead.call, lead.put].filter(isRated).sort(byExposure);
  if (!input.marketOpen) {
    const heldTime = levels.state === 'shown' ? levels.asOfText : null;
    result = {
      kind: 'closed',
      pill: null,
      text:
        heldTime == null
          ? 'Session closed.'
          : `Session closed. Levels as of ${heldTime}.`,
    };
  } else if (views.length === 0) {
    result = {
      kind: 'no_short_strikes',
      pill: null,
      text: nearestLevelsSentence(shown, spot),
    };
  } else if (worst == null) {
    result = {
      kind: 'no_expected_move',
      pill: null,
      text: 'Expected move unavailable. Distances only.',
    };
  } else {
    result = statusResult(worst, other);
  }

  const levelsShown = levels.state === 'shown' ? shown : null;
  return {
    result,
    rows,
    above,
    below,
    levels,
    band,
    spotText: formatOneDecimal(spot),
    summary: {
      call: summaryLine(lead.call, spot, band, levelsShown),
      put: summaryLine(lead.put, spot, band, levelsShown),
    },
  };
}
