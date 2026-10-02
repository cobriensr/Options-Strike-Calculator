/**
 * Futures context formatting for the /api/analyze endpoint.
 *
 * Reads the latest futures_snapshots row per symbol plus the futures_bars
 * bar that priced it, and assembles a human-readable context block that
 * Claude can use for analysis. A symbol whose underlying bar is older
 * than MAX_PRICE_AGE_MS (relative to the analysis reference time) is
 * omitted and named in an "Omitted (stale)" note: the snapshot cron
 * keeps writing fresh-timestamped rows with a frozen price when the bar
 * feed dies, so the snapshot's own ts says nothing about the price.
 *
 * The block also carries the VIX term structure (spot VIX / VIX3M plus
 * UW's VIX-futures label) from vix-term-structure.ts. It has no history,
 * so it appears only when the analysis date is today.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { z } from 'zod';
import { fmtPct, fmtPrice } from './format-helpers.js';
import logger from './logger.js';
import { numOrNull } from './numeric-coercion.js';
import { metrics, Sentry } from './sentry.js';
import {
  fetchVixTermStructure,
  type LiveVixTermReading,
  type VixTermBand,
  type VixTermReading,
} from './vix-term-structure.js';
import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import { etWallClockToUtcIso, getETDateStr } from '../../src/utils/timezone.js';

type Sql = NeonQueryFunction<false, false>;

// ── Row schemas ────────────────────────────────────────────
//
// Neon returns rows as untyped `Record<string, unknown>` arrays. Parsing
// each row through Zod catches schema drift the day it happens (column
// renames, type changes) instead of letting stale assumptions leak into
// the Claude prompt.

const futuresSnapshotSchema = z.object({
  symbol: z.string(),
  // TIMESTAMPTZ columns — Neon may hand back a Date or an ISO string; an
  // unparseable value fails validation and the row is dropped.
  ts: z.coerce.date(),
  // Latest futures_bars ts at-or-before the snapshot, i.e. the bar that
  // priced it. Null when no bar exists — nothing backs the price.
  bar_ts: z.coerce.date().nullable(),
  price: z.string(),
  change_1h_pct: z.string().nullable(),
  change_day_pct: z.string().nullable(),
  volume_ratio: z.string().nullable(),
});
type FuturesSnapshot = z.infer<typeof futuresSnapshotSchema>;

/**
 * A symbol whose price comes from a bar older than this (relative to the
 * analysis reference time) is omitted. Bars are 1-minute and the
 * snapshot cron runs every 5 minutes, so a healthy price is at most ~6
 * minutes old; 15 minutes tolerates about two missed cron runs.
 */
const MAX_PRICE_AGE_MS = 15 * 60 * 1000;
const MAX_PRICE_AGE_MIN = MAX_PRICE_AGE_MS / 60_000;

/**
 * The VIX term structure as the prompt may use it. `live` is set only
 * when its quotes are within MAX_PRICE_AGE_MS of the reference time.
 * `lastClose` and `futuresRegime` are the latest daily closes, so they
 * only reach the prompt for an analysis of today.
 */
interface VixTermContext {
  live: LiveVixTermReading | null;
  lastClose: VixTermReading | null;
  futuresRegime: VixTermBand | null;
}

interface DerivedSignals {
  esSpxBasis: number | null;
  nqEsRatio: number | null;
  vixTerm: VixTermContext | null;
}

// ── Helpers ────────────────────────────────────────────────

function fmtVolRatio(val: number | null): string {
  if (val == null) return 'N/A';
  const label =
    val >= 2.0
      ? 'VERY ELEVATED'
      : val >= 1.3
        ? 'ELEVATED'
        : val >= 0.7
          ? 'NORMAL'
          : 'LOW';
  return `${val.toFixed(1)}× 20-day avg — ${label}`;
}

// ── Per-symbol renderers ──────────────────────────────────
//
// Each renderer takes the snapshot map (so it can resolve cross-symbol
// references like NQ-vs-ES alignment or ZN flight-to-safety) plus the
// computed `derived` signals, and returns the lines for its section.
// Returns `null` when the symbol's snapshot is missing — the orchestrator
// drops null entries before joining sections.
//
// Cross-symbol references stay with their owning renderer rather than
// living in the orchestrator. This keeps the conditional cross-talk
// readable next to the symbol that owns the section, at the cost of
// each cross-referencing renderer reading two snapshots from the map.

type Renderer = (
  bySymbol: Map<string, FuturesSnapshot>,
  derived: DerivedSignals,
) => string[] | null;

const renderEs: Renderer = (bySymbol, derived) => {
  const es = bySymbol.get('ES');
  if (!es) return null;

  const esPrice = numOrNull(es.price);
  const lines = [
    `ES Futures (/ES):`,
    `  Current: ${fmtPrice(esPrice)} | 1H: ${fmtPct(numOrNull(es.change_1h_pct))} | Day: ${fmtPct(numOrNull(es.change_day_pct))}`,
  ];
  const volRatio = numOrNull(es.volume_ratio);
  if (volRatio != null) {
    lines.push(`  Volume Ratio: ${fmtVolRatio(volRatio)}`);
  }
  if (derived.esSpxBasis != null) {
    const basisLabel =
      Math.abs(derived.esSpxBasis) <= 2
        ? 'normal'
        : Math.abs(derived.esSpxBasis) <= 5
          ? 'slightly wide'
          : 'STRESS';
    lines.push(
      `  ES-SPX Basis: ${derived.esSpxBasis >= 0 ? '+' : ''}${derived.esSpxBasis.toFixed(2)} pts (${basisLabel})`,
    );
  }
  return lines;
};

const renderNq: Renderer = (bySymbol, derived) => {
  const nq = bySymbol.get('NQ');
  if (!nq) return null;

  const lines = [
    `NQ Futures (/NQ):`,
    `  Current: ${fmtPrice(numOrNull(nq.price))} | 1H: ${fmtPct(numOrNull(nq.change_1h_pct))} | Day: ${fmtPct(numOrNull(nq.change_day_pct))}`,
  ];
  if (derived.nqEsRatio != null) {
    lines.push(`  NQ/ES Ratio: ${derived.nqEsRatio.toFixed(3)}`);
  }
  // Divergence check: compare NQ and ES day direction
  const esDay = numOrNull(bySymbol.get('ES')?.change_day_pct ?? null);
  const nqDay = numOrNull(nq.change_day_pct);
  if (esDay != null && nqDay != null) {
    const aligned = (esDay >= 0 && nqDay >= 0) || (esDay < 0 && nqDay < 0);
    lines.push(`  NQ-ES Direction: ${aligned ? 'ALIGNED' : 'DIVERGING'}`);
  }
  return lines;
};

function fmtVixReading(r: VixTermReading): string {
  return `VIX ${fmtPrice(r.vix)} / VIX3M ${fmtPrice(r.vix3m)} = ${r.ratio.toFixed(3)} (${r.band})`;
}

/** Spot VIX / VIX3M section; reads only `derived.vixTerm`. */
const renderVix: Renderer = (_bySymbol, derived) => {
  const term = derived.vixTerm;
  if (term == null) return null;
  const { live, lastClose, futuresRegime } = term;

  const lines = [`VIX Term Structure (VIX/VIX3M):`];
  if (live) {
    lines.push(`  Live: ${fmtVixReading(live)}`);
  } else if (lastClose) {
    lines.push(`  Live: unavailable — only the latest daily close below`);
  } else {
    lines.push(`  Live: unavailable`);
  }
  if (lastClose) {
    lines.push(`  Latest daily close: ${fmtVixReading(lastClose)}`);
  }
  if (futuresRegime) {
    lines.push(
      `  VIX futures regime (front two VX, latest close): ${futuresRegime}`,
    );
  }
  if (live && lastClose && live.band !== lastClose.band) {
    lines.push(
      `  Shift: ${lastClose.band} at the latest close → ${live.band} live`,
    );
  }

  const band = live?.band ?? lastClose?.band ?? null;
  if (band === 'BACKWARDATION') {
    lines.push(
      `  Signal: Near-term stress priced in. Straddle cones may understate range.`,
    );
  } else if (band === 'CONTANGO') {
    lines.push(`  Signal: Normal vol regime. Favorable for premium selling.`);
  }
  return lines;
};

const renderZn: Renderer = (bySymbol) => {
  const zn = bySymbol.get('ZN');
  if (!zn) return null;

  const lines = [
    `10Y Treasury (/ZN):`,
    `  Current: ${fmtPrice(numOrNull(zn.price))} | 1H: ${fmtPct(numOrNull(zn.change_1h_pct))} | Day: ${fmtPct(numOrNull(zn.change_day_pct))}`,
  ];
  // Flight-to-safety check
  const znDay = numOrNull(zn.change_day_pct);
  const esDay = numOrNull(bySymbol.get('ES')?.change_day_pct ?? null);
  if (znDay != null && esDay != null) {
    if (znDay > 0.1 && esDay < -0.2) {
      lines.push(
        `  Signal: FLIGHT TO SAFETY — bonds rallying + equities selling. Trending day likely.`,
      );
    } else if (znDay < -0.1 && esDay < -0.2) {
      lines.push(
        `  Signal: Broad liquidation — bonds and equities selling. Snapback reversal possible.`,
      );
    } else if (Math.abs(znDay) < 0.1) {
      lines.push(`  Signal: ZN flat — equity move is not macro-driven.`);
    }
  }
  return lines;
};

const renderRty: Renderer = (bySymbol) => {
  const rty = bySymbol.get('RTY');
  if (!rty) return null;

  const lines = [
    `Russell 2000 (/RTY):`,
    `  Current: ${fmtPrice(numOrNull(rty.price))} | 1H: ${fmtPct(numOrNull(rty.change_1h_pct))} | Day: ${fmtPct(numOrNull(rty.change_day_pct))}`,
  ];
  const rtyDay = numOrNull(rty.change_day_pct);
  const esDay = numOrNull(bySymbol.get('ES')?.change_day_pct ?? null);
  if (rtyDay != null && esDay != null) {
    const aligned = (rtyDay >= 0 && esDay >= 0) || (rtyDay < 0 && esDay < 0);
    lines.push(
      `  RTY-ES Breadth: ${aligned ? 'ALIGNED (broad move)' : 'DIVERGING (narrow/fragile)'}`,
    );
  }
  return lines;
};

const renderCl: Renderer = (bySymbol) => {
  const cl = bySymbol.get('CL');
  if (!cl) return null;

  const lines = [
    `Crude Oil (/CL):`,
    `  Current: ${fmtPrice(numOrNull(cl.price))} | 1H: ${fmtPct(numOrNull(cl.change_1h_pct))} | Day: ${fmtPct(numOrNull(cl.change_day_pct))}`,
  ];
  const clDay = numOrNull(cl.change_day_pct);
  if (clDay != null) {
    if (clDay < -2) {
      lines.push(
        `  Signal: Oil weakness → inflation expectations easing → vol compression favorable`,
      );
    } else if (clDay > 2) {
      lines.push(
        `  Signal: Oil strength → inflation/geopolitical risk → vol expansion likely`,
      );
    }
  }
  return lines;
};

const renderGc: Renderer = (bySymbol) => {
  const gc = bySymbol.get('GC');
  if (!gc) return null;

  const lines = [
    `Gold (/GC):`,
    `  Current: ${fmtPrice(numOrNull(gc.price))} | 1H: ${fmtPct(numOrNull(gc.change_1h_pct))} | Day: ${fmtPct(numOrNull(gc.change_day_pct))}`,
  ];
  const gcDay = numOrNull(gc.change_day_pct);
  const esDay = numOrNull(bySymbol.get('ES')?.change_day_pct ?? null);
  const znDay = numOrNull(bySymbol.get('ZN')?.change_day_pct ?? null);
  if (gcDay != null && esDay != null) {
    if (gcDay > 0.5 && esDay < -0.2) {
      lines.push(
        `  Signal: SAFE HAVEN BID — gold rising while equities fall. Fear-driven positioning.`,
      );
      if (znDay != null && znDay > 0.1) {
        lines.push(
          `  Gold + Bonds both bid = HIGH-CONVICTION flight to safety.`,
        );
      }
    } else if (gcDay < -0.5 && esDay > 0.2) {
      lines.push(
        `  Signal: Risk-on rotation — gold sold as equities rally. Favorable for premium selling.`,
      );
    }
  }
  return lines;
};

// Renderer iteration order is the section order in the prompt
// (ES → NQ → VIX → ZN → RTY → CL → GC). DX and VX1/VX2 have no
// renderer: DX (ICE) and VX (Cboe CFE) were never on a feed we still
// have, so any such snapshot row left in the table is ignored. The VIX
// section comes from spot VIX / VIX3M instead.
const SYMBOL_RENDERERS: ReadonlyArray<readonly [string, Renderer]> = [
  ['ES', renderEs],
  ['NQ', renderNq],
  ['VIX', renderVix],
  ['ZN', renderZn],
  ['RTY', renderRty],
  ['CL', renderCl],
  ['GC', renderGc],
];

/**
 * futures_snapshots / futures_bars symbols to read, in section order.
 * The query returns rows in this order, so the stale note lists symbols
 * in it too.
 */
const CONTEXT_SYMBOLS: readonly string[] = [
  'ES',
  'NQ',
  'ZN',
  'RTY',
  'CL',
  'GC',
];

// ── Core formatter ─────────────────────────────────────────

/**
 * The moment freshness is judged against, and the upper bound of the
 * read so later rows can't leak in: the entry-time cutoff (`asOf`) when
 * it parses, else the analysis date's actual cash close (13:00 ET on
 * early-close days, 16:00 ET otherwise, including holidays) — so a
 * historical run with no entry time still reads that day's session
 * rather than being judged against today's wall clock. Either is then
 * clamped to wall clock (the calculator defaults to 10:00 AM CT outside
 * market hours, which can be in the future).
 */
function resolveReferenceTime(
  analysisDate: string,
  asOf: string | undefined,
): Date {
  const now = new Date();
  const cutoff = parseIso(asOf) ?? sessionClose(analysisDate);
  if (cutoff == null) return now;
  return cutoff < now ? cutoff : now;
}

/** The date's cash close: 13:00 ET on early-close days, else 16:00 ET. */
function sessionClose(analysisDate: string): Date | null {
  const closeMinuteET = (getMarketCloseHourET(analysisDate) ?? 16) * 60;
  return parseIso(etWallClockToUtcIso(analysisDate, closeMinuteET));
}

function parseIso(iso: string | null | undefined): Date | null {
  if (iso == null) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * One query: for each CONTEXT_SYMBOLS entry, the latest futures_snapshots
 * row at-or-before the reference time (seek on UNIQUE(symbol, ts)) and
 * the latest futures_bars ts at-or-before that snapshot (seek on
 * idx_futures_bars_symbol_ts). Rows failing schema validation are dropped
 * with a warning; a query failure is reported and yields no rows, so the
 * VIX section can still render.
 */
async function readFuturesSnapshots(
  sql: Sql,
  referenceIso: string,
): Promise<FuturesSnapshot[]> {
  const snapshots: FuturesSnapshot[] = [];
  try {
    const rawRows = await sql`
      SELECT s.symbol, snap.ts, bar.bar_ts, snap.price,
             snap.change_1h_pct, snap.change_day_pct, snap.volume_ratio
      FROM unnest(${CONTEXT_SYMBOLS as string[]}::text[])
        WITH ORDINALITY AS s(symbol, ord)
      CROSS JOIN LATERAL (
        SELECT ts, price, change_1h_pct, change_day_pct, volume_ratio
        FROM futures_snapshots
        WHERE symbol = s.symbol AND ts <= ${referenceIso}
        ORDER BY ts DESC
        LIMIT 1
      ) AS snap
      CROSS JOIN LATERAL (
        SELECT MAX(ts) AS bar_ts
        FROM futures_bars
        WHERE symbol = s.symbol AND ts <= snap.ts
      ) AS bar
      ORDER BY s.ord
    `;
    for (const row of rawRows) {
      const parsed = futuresSnapshotSchema.safeParse(row);
      if (parsed.success) {
        snapshots.push(parsed.data);
      } else {
        logger.warn(
          { issues: parsed.error.issues, row },
          'futures_snapshots row failed schema validation — dropping',
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err },
      'futures context query failed — omitting futures symbols',
    );
    metrics.increment('futures_context.fetch_error');
    Sentry.captureException(err);
    return [];
  }
  return snapshots;
}

/**
 * Whether UW's "latest close" can be used at `referenceTime` without
 * look-ahead. Before today's cash close the block can only hold the prior
 * session's close. Once the session is over it may already hold today's,
 * which is look-ahead for a run whose reference time is earlier in the
 * session (e.g. a replay of the morning entry) — so it is dropped for
 * those runs. A run referenced at the close itself keeps it.
 */
function uwCloseUsable(
  analysisDate: string,
  referenceTime: Date,
  now: Date,
): boolean {
  const close = sessionClose(analysisDate);
  if (close == null) return false;
  return now < close || referenceTime >= close;
}

/**
 * The VIX term structure for this analysis, or null when there is
 * nothing usable. Neither source has history — UW's block is the latest
 * daily closes and the Schwab quote is "now" — so a run for any other
 * date gets nothing (and makes no calls). The live ratio is used only
 * when its quotes are within MAX_PRICE_AGE_MS of the reference time in
 * either direction: a run with an entry time hours before now falls back
 * to the close, while a live run a few minutes past its entry time keeps
 * the current quote.
 */
async function resolveVixTerm(
  analysisDate: string,
  referenceTime: Date,
): Promise<VixTermContext | null> {
  const now = new Date();
  if (analysisDate !== getETDateStr(now)) return null;

  const term = await fetchVixTermStructure();
  const liveMs = term.live ? Date.parse(term.live.asOf) : Number.NaN;
  const live =
    Number.isFinite(liveMs) &&
    Math.abs(referenceTime.getTime() - liveMs) <= MAX_PRICE_AGE_MS
      ? term.live
      : null;
  const closeUsable = uwCloseUsable(analysisDate, referenceTime, now);
  const lastClose = closeUsable ? term.lastClose : null;
  const futuresRegime = closeUsable ? term.futuresRegime : null;
  if (live == null && lastClose == null && futuresRegime == null) {
    return null;
  }
  return { live, lastClose, futuresRegime };
}

/**
 * Build the futures context block for Claude analysis.
 *
 * Freshness is the age of the bar behind each snapshot — the price the
 * snapshot actually carries — not the snapshot's write time. A symbol
 * with no snapshot at all is simply absent (never existed); a symbol
 * whose bar is stale or missing is dropped from every section and
 * derivation and named in a trailing "Omitted (stale …)" note.
 *
 * Returns null when nothing is left to render (no fresh futures and no
 * VIX term structure); the caller then lists "Futures Context" in the
 * unavailable-data manifest.
 *
 * @param asOf - optional ISO entry-time cutoff (`parseEntryTimeAsUtc`)
 */
export async function formatFuturesForClaude(
  sql: Sql,
  analysisDate: string,
  spxPrice?: number,
  asOf?: string,
): Promise<string | null> {
  const referenceTime = resolveReferenceTime(analysisDate, asOf);
  const referenceIso = referenceTime.toISOString();
  const [snapshots, vixTerm] = await Promise.all([
    readFuturesSnapshots(sql, referenceIso),
    resolveVixTerm(analysisDate, referenceTime),
  ]);

  // Build a lookup map of fresh-priced snapshots only — a stale row must
  // not feed its own section or any cross-symbol derivation (basis,
  // ratios, flight-to-safety).
  const bySymbol = new Map<string, FuturesSnapshot>();
  const stale: Array<{
    symbol: string;
    barTs: string | null;
    ageMin: number | null;
  }> = [];
  for (const row of snapshots) {
    const ageMs =
      row.bar_ts == null
        ? null
        : referenceTime.getTime() - row.bar_ts.getTime();
    if (ageMs == null || ageMs > MAX_PRICE_AGE_MS) {
      stale.push({
        symbol: row.symbol,
        barTs: row.bar_ts?.toISOString() ?? null,
        ageMin: ageMs == null ? null : Math.round(ageMs / 60_000),
      });
    } else {
      bySymbol.set(row.symbol, row);
    }
  }
  if (stale.length > 0) {
    logger.warn(
      { stale, referenceTime: referenceIso },
      'futures price stale — omitting symbols from analyze context',
    );
    metrics.increment('futures_context.stale_snapshot');
  }

  const derived: DerivedSignals = {
    ...computeDerivedSignals(bySymbol, spxPrice),
    vixTerm,
  };

  // Per-symbol sections via the renderer table.
  const sections: string[] = [];
  for (const [, renderer] of SYMBOL_RENDERERS) {
    const lines = renderer(bySymbol, derived);
    if (lines) sections.push(lines.join('\n'));
  }

  if (sections.length === 0) return null;

  // Name what was dropped so Claude can tell "stale" from "never existed".
  if (stale.length > 0) {
    const names = stale.map((s) => s.symbol).join(', ');
    sections.push(`Omitted (stale >${MAX_PRICE_AGE_MIN}m): ${names}`);
  }

  return '## Futures Context\n\n' + sections.join('\n\n');
}

// ── Derived signals ────────────────────────────────────────

function computeDerivedSignals(
  bySymbol: Map<string, FuturesSnapshot>,
  spxPrice?: number,
): Omit<DerivedSignals, 'vixTerm'> {
  const result: Omit<DerivedSignals, 'vixTerm'> = {
    esSpxBasis: null,
    nqEsRatio: null,
  };

  // ES-SPX basis
  const esPrice = numOrNull(bySymbol.get('ES')?.price ?? null);
  if (esPrice != null && spxPrice != null && spxPrice > 0) {
    result.esSpxBasis = esPrice - spxPrice;
  }

  // NQ/ES ratio
  const nqPrice = numOrNull(bySymbol.get('NQ')?.price ?? null);
  if (nqPrice != null && esPrice != null && esPrice > 0) {
    result.nqEsRatio = nqPrice / esPrice;
  }

  return result;
}
