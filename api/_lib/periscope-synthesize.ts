/**
 * DB-backed substitute for Pass 1A (extractChartStructure) and Pass 1B
 * (extractHeatMapStrikes) in /api/periscope-chat.
 *
 * Pass 1A and Pass 1B are vision-only OCR calls against user-uploaded
 * screenshots. When the periscope-scraper Railway service is feeding
 * `periscope_snapshots` + `cone_levels` we already have the same
 * numeric content that vision would extract — at higher fidelity, with
 * no OCR hallucinations, and instantly. This module reads those tables
 * and returns the *same shapes* the vision passes return, so the
 * downstream prompt assembly in periscope-chat.ts is identical
 * regardless of which path produced the inputs.
 *
 * Used when the request body has `images: []` — i.e. the user clicked
 * Submit without staging any screenshots and we have stored data for
 * the requested slot. When the DB is missing data (scraper gap, fresh
 * day before first slot, weekend / holiday) the function returns null
 * and the handler must bail with a clear "no data for this slot —
 * upload screenshots" message.
 */

import { getDb } from './db.js';
import type {
  PeriscopeExtractionResult,
  HeatMapExtraction,
  HeatMapStrike,
} from './periscope-extract.js';
import type { PeriscopeStructuredFields } from './periscope-db.js';

/**
 * How many strikes per panel to surface in the heat-map block. The
 * vision Pass 1B is targeted at the central ~100-pt strike band on a
 * standard heat-map screenshot — typically yielding 8–12 cells per
 * panel. We mirror that volume so the prompt's heat-map block has a
 * comparable shape regardless of source.
 */
const HEATMAP_TOP_N_PER_SIGN = 6;

interface SnapshotRow {
  panel: string;
  strike: number;
  value: number;
}

/**
 * Empty PeriscopeStructuredFields with the three Pass-1A-supplied
 * numeric values pinned and everything else null. Mirrors the shape
 * the vision pass returns on a partial extraction.
 */
function emptyFieldsWithCone(args: {
  spot: number;
  coneLower: number | null;
  coneUpper: number | null;
}): PeriscopeStructuredFields {
  return {
    spot: args.spot,
    cone_lower: args.coneLower,
    cone_upper: args.coneUpper,
    long_trigger: null,
    short_trigger: null,
    regime_tag: null,
    bias: null,
    trade_types_recommended: [],
    trade_types_avoided: [],
    key_levels: null,
    expected_dealer_behavior: null,
    confidence: null,
    confidence_basis: null,
    futures_plan: null,
  };
}

/**
 * Pull top-N positive + top-N negative strikes for a given panel from
 * the latest periscope_snapshots slot at or before `readTimeIso` for
 * `expiry`. Returns [] when no rows exist (caller treats as panel
 * unavailable).
 */
async function fetchTopStrikes(
  expiry: string,
  panel: 'gamma' | 'charm',
  readTimeIso: string,
): Promise<HeatMapStrike[]> {
  const sql = getDb();
  // Find the latest captured slot for this panel at or before
  // readTimeIso. We don't need a full slot read — only the panel's
  // top values.
  const slotRows = (await sql`
    SELECT MAX(captured_at) AS captured_at
    FROM periscope_snapshots
    WHERE expiry = ${expiry}
      AND panel = ${panel}
      AND captured_at <= ${readTimeIso}
  `) as Array<{ captured_at: string | Date | null }>;
  const capturedAt = slotRows[0]?.captured_at;
  if (capturedAt == null) return [];

  const rows = (await sql`
    SELECT panel, strike, value
    FROM periscope_snapshots
    WHERE expiry = ${expiry}
      AND panel = ${panel}
      AND captured_at = ${capturedAt}
  `) as Array<{ panel: string; strike: number; value: string | number }>;

  if (rows.length === 0) return [];

  const numeric: SnapshotRow[] = rows.map((r) => ({
    panel: r.panel,
    strike: r.strike,
    value: typeof r.value === 'string' ? Number.parseFloat(r.value) : r.value,
  }));

  const positive = numeric
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, HEATMAP_TOP_N_PER_SIGN);
  const negative = numeric
    .filter((r) => r.value < 0)
    .sort((a, b) => a.value - b.value)
    .slice(0, HEATMAP_TOP_N_PER_SIGN);

  return [
    ...positive.map<HeatMapStrike>((r) => ({
      strike: r.strike,
      value: r.value,
      color: 'green',
    })),
    ...negative.map<HeatMapStrike>((r) => ({
      strike: r.strike,
      value: r.value,
      color: 'red',
    })),
  ].sort((a, b) => a.strike - b.strike);
}

interface ConeLevelsRow {
  cone_lower: string | number;
  cone_upper: string | number;
}

/** Read the day's cone bounds from `cone_levels`. Returns null if not computed yet. */
async function fetchConeBounds(
  date: string,
): Promise<{ coneLower: number; coneUpper: number } | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT cone_lower, cone_upper
    FROM cone_levels
    WHERE date = ${date}
  `) as ConeLevelsRow[];
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    coneLower: Number(r.cone_lower),
    coneUpper: Number(r.cone_upper),
  };
}

/** Strike window (±pts from spot) for charm-zero integration. Matches
 *  the WIDE_SPOT_HALFWIDTH constant in periscope-format.ts so the
 *  panel and Claude's prompt agree on which strikes count toward the
 *  sign-change. The skill's intent is "near-spot EoD drift pivot" —
 *  walking the full chain (which can extend 1000+ pts from spot)
 *  finds sign changes way out in deep OTM territory that aren't the
 *  pivot a trader cares about.
 *
 *  2026-05-08: panel returned 7310 vs Claude returned 7600 with spot
 *  at 7391 — same algorithm, different bounds. Aligning to ±100. */
const CHARM_ZERO_HALFWIDTH = 100;

/**
 * Compute the charm-zero strike — the price where the cumulative charm
 * sum (sorted by strike, low → high) genuinely flips sign within ±100
 * of spot.
 *
 * Pass 1B's heat-map extraction only feeds Claude the top-N positive +
 * top-N negative strikes per panel, so Claude can't reliably identify
 * the contiguous sign-change point. Computing it here from the full
 * charm grid (filtered to ±100 of spot) and injecting it into the
 * prompt directly fills `key_levels.charm_zero` deterministically AND
 * matches what the panel renders.
 */
async function fetchCharmZeroStrike(
  expiry: string,
  readTimeIso: string,
  spot: number,
): Promise<number | null> {
  const sql = getDb();
  const slotRows = (await sql`
    SELECT MAX(captured_at) AS captured_at
    FROM periscope_snapshots
    WHERE expiry = ${expiry}
      AND panel = 'charm'
      AND captured_at <= ${readTimeIso}
  `) as Array<{ captured_at: string | Date | null }>;
  const capturedAt = slotRows[0]?.captured_at;
  if (capturedAt == null) return null;

  // strike is INTEGER in periscope_snapshots — floor/ceil so a fractional
  // spot (e.g. 7398.34) doesn't make Postgres reject the bound parameters
  // with "invalid input syntax for type integer".
  const minStrike = Math.floor(spot - CHARM_ZERO_HALFWIDTH);
  const maxStrike = Math.ceil(spot + CHARM_ZERO_HALFWIDTH);
  const rows = (await sql`
    SELECT strike, value
    FROM periscope_snapshots
    WHERE expiry = ${expiry}
      AND panel = 'charm'
      AND captured_at = ${capturedAt}
      AND strike >= ${minStrike}
      AND strike <= ${maxStrike}
    ORDER BY strike ASC
  `) as Array<{ strike: number; value: string | number }>;
  if (rows.length === 0) return null;

  let runningSum = 0;
  for (const r of rows) {
    const v =
      typeof r.value === 'string' ? Number.parseFloat(r.value) : r.value;
    const prev = runningSum;
    runningSum += v;
    if (
      prev !== 0 &&
      runningSum !== 0 &&
      Math.sign(prev) !== Math.sign(runningSum)
    ) {
      return r.strike;
    }
  }
  return null;
}

export interface SynthesizeResult {
  extraction: PeriscopeExtractionResult;
  heatMaps: HeatMapExtraction | null;
  /** Pre-computed charm-zero strike (cumulative sign change), null when
   *  the cumulative sum never crosses or no charm rows exist. */
  charmZeroStrike: number | null;
}

/**
 * Build Pass 1A + Pass 1B equivalents from the DB.
 *
 * Returns null when the DB has nothing for the requested slot
 * (scraper gap, fresh day, weekend). The handler should treat null as
 * "no data — caller must upload screenshots" so we don't silently
 * call Claude with an empty heat-map block on a day that should have
 * data.
 *
 * `expiry` is the SPX 0DTE expiry the read targets — equal to
 * `tradingDate` in 0DTE-only mode.
 */
export async function synthesizeFromDb(args: {
  tradingDate: string;
  readTimeIso: string;
  spot: number;
}): Promise<SynthesizeResult | null> {
  const { tradingDate, readTimeIso, spot } = args;

  const [coneBounds, gexStrikes, charmStrikes, charmZeroStrike] =
    await Promise.all([
      fetchConeBounds(tradingDate),
      fetchTopStrikes(tradingDate, 'gamma', readTimeIso),
      fetchTopStrikes(tradingDate, 'charm', readTimeIso),
      fetchCharmZeroStrike(tradingDate, readTimeIso, spot),
    ]);

  // Gate: if we have NEITHER a cone NOR any periscope rows, the DB
  // genuinely has no data for this slot. Bail so the caller can ask
  // for screenshots.
  if (
    coneBounds == null &&
    gexStrikes.length === 0 &&
    charmStrikes.length === 0
  ) {
    return null;
  }

  const extraction: PeriscopeExtractionResult = {
    structured: emptyFieldsWithCone({
      spot,
      coneLower: coneBounds?.coneLower ?? null,
      coneUpper: coneBounds?.coneUpper ?? null,
    }),
    chartDate: tradingDate,
  };

  const heatMaps: HeatMapExtraction | null =
    gexStrikes.length > 0 || charmStrikes.length > 0
      ? { gex: gexStrikes, charm: charmStrikes }
      : null;

  return { extraction, heatMaps, charmZeroStrike };
}
