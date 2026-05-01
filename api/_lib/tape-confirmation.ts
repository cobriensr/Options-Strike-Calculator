/**
 * Tape-confirmation overlay for gamma squeeze events.
 *
 * Layers four directional confirmation signals on top of an alert. Each
 * signal compares same-ticker / market-wide flow data to the alert's
 * direction (call = expects bullish tape, put = expects bearish tape):
 *
 *   - market_tide          NCP > NPP for calls; NCP < NPP for puts
 *   - market_tide_otm      same rule, OTM-only variant
 *   - per-ticker flow      ncp > npp for calls (uses the closest match
 *                          to the alert ticker — spx_flow, spy_flow,
 *                          qqq_flow, etc.)
 *   - per-ticker etf_tide  same rule for SPY/QQQ alerts (other tickers
 *                          skip this signal)
 *
 * Returns a structured result keyed by signal name with the value of the
 * comparison plus an aggregate count of "agreeing" signals. The UI
 * renders this as a `tape K/N` badge with a tooltip listing each signal.
 *
 * This is NOT a binary filter — the precision-stack pass already does
 * that. Tape agreement is a soft confluence indicator the trader uses
 * alongside their own macro read.
 */

// ── Types ────────────────────────────────────────────────────

export type AlertSide = 'call' | 'put';

/** One row of flow_data — only the comparison fields we actually use. */
export interface FlowRow {
  ncp: number | null;
  npp: number | null;
  otmNcp: number | null;
  otmNpp: number | null;
  netVolume: number | null;
}

/** Inputs to the tape evaluator — null when source has no data today. */
export interface TapeInputs {
  marketTide: FlowRow | null;
  marketTideOtm: FlowRow | null;
  /** ncp/npp from {ticker}_flow (or null if no per-ticker source). */
  tickerFlow: FlowRow | null;
  /** ncp/npp from {ticker}_etf_tide for SPY/QQQ alerts only. */
  etfTide: FlowRow | null;
}

/** One per-signal verdict shipped to the UI. */
export interface TapeSignalResult {
  /** Stable key for testid + tooltip line. */
  key: 'market_tide' | 'market_tide_otm' | 'ticker_flow' | 'etf_tide';
  /** Display label in the tooltip. */
  label: string;
  /** True iff the signal agrees with the alert side. Null = no data. */
  agrees: boolean | null;
  /** The actual values used for the comparison, for display in the tooltip. */
  ncp: number | null;
  npp: number | null;
}

export interface TapeAgreement {
  /** Per-signal results, in display order. */
  signals: TapeSignalResult[];
  /**
   * Count of signals where `agrees` is true. Maximum is `total` —
   * signals with `agrees: null` (no data for that source) are excluded.
   */
  agreeCount: number;
  /** Total signals with non-null verdicts. May be < signals.length. */
  total: number;
}

// ── Pure evaluators ──────────────────────────────────────────

/**
 * For a CALL alert we expect ncp > npp (bullish call dominance).
 * For a PUT alert we expect ncp < npp.
 * Null when either side is missing.
 */
function compareNcpVsNpp(
  side: AlertSide,
  ncp: number | null,
  npp: number | null,
): boolean | null {
  if (
    ncp == null ||
    npp == null ||
    !Number.isFinite(ncp) ||
    !Number.isFinite(npp)
  ) {
    return null;
  }
  return side === 'call' ? ncp > npp : ncp < npp;
}

/**
 * Build the four-signal verdict. Caller passes the latest row per source
 * (or null if no data today). Order is deliberate: market-wide signals
 * first, then per-ticker signals — that's how the tooltip will list them.
 */
export function evaluateTapeAgreement(
  side: AlertSide,
  inputs: TapeInputs,
): TapeAgreement {
  const signals: TapeSignalResult[] = [];

  // Market tide (all-in)
  signals.push({
    key: 'market_tide',
    label: 'Market Tide (all-in)',
    agrees: inputs.marketTide
      ? compareNcpVsNpp(side, inputs.marketTide.ncp, inputs.marketTide.npp)
      : null,
    ncp: inputs.marketTide?.ncp ?? null,
    npp: inputs.marketTide?.npp ?? null,
  });

  // Market tide OTM-only
  signals.push({
    key: 'market_tide_otm',
    label: 'Market Tide (OTM)',
    agrees: inputs.marketTideOtm
      ? compareNcpVsNpp(
          side,
          inputs.marketTideOtm.ncp,
          inputs.marketTideOtm.npp,
        )
      : null,
    ncp: inputs.marketTideOtm?.ncp ?? null,
    npp: inputs.marketTideOtm?.npp ?? null,
  });

  // Per-ticker flow (cumulative directional delta proxy)
  signals.push({
    key: 'ticker_flow',
    label: 'Per-ticker flow',
    agrees: inputs.tickerFlow
      ? compareNcpVsNpp(side, inputs.tickerFlow.ncp, inputs.tickerFlow.npp)
      : null,
    ncp: inputs.tickerFlow?.ncp ?? null,
    npp: inputs.tickerFlow?.npp ?? null,
  });

  // Per-ticker ETF tide (SPY/QQQ only — null for index/single-name)
  signals.push({
    key: 'etf_tide',
    label: 'ETF tide',
    agrees: inputs.etfTide
      ? compareNcpVsNpp(side, inputs.etfTide.ncp, inputs.etfTide.npp)
      : null,
    ncp: inputs.etfTide?.ncp ?? null,
    npp: inputs.etfTide?.npp ?? null,
  });

  const decided = signals.filter((s) => s.agrees != null);
  return {
    signals,
    agreeCount: decided.filter((s) => s.agrees === true).length,
    total: decided.length,
  };
}

/**
 * Map an alert ticker to the per-ticker flow source name. SPXW / SPX
 * map to spx_flow; SPY/QQQ to their dedicated sources; everything else
 * has no per-ticker flow source and returns null.
 */
export function tickerFlowSource(ticker: string): string | null {
  if (ticker === 'SPXW' || ticker === 'SPX') return 'spx_flow';
  if (ticker === 'SPY') return 'spy_flow';
  if (ticker === 'QQQ') return 'qqq_flow';
  return null;
}

/**
 * Map an alert ticker to its ETF tide source. Only SPY and QQQ have one.
 */
export function etfTideSource(ticker: string): string | null {
  if (ticker === 'SPY') return 'spy_etf_tide';
  if (ticker === 'QQQ') return 'qqq_etf_tide';
  return null;
}
