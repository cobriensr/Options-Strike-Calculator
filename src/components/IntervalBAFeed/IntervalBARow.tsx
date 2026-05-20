/**
 * IntervalBARow — single row in the IntervalBAFeed table.
 *
 * Renders the dominant ask-side print details + a click-through to UW's
 * per-contract page. Severity drives a left-edge color stripe matching
 * the live banner's tinting (extreme = red pulse-class, critical =
 * red mute, warning = caution). Expand toggle lazy-loads twin chart
 * panels (contract tape + ticker net flow) mirroring Lottery / Silent
 * Boom rows.
 */

import { memo, useMemo, useState } from 'react';
import { useContractTape } from '../../hooks/useContractTape.js';
import { useNetFlowHistory } from '../../hooks/useNetFlowHistory.js';
import { useTickerCandles } from '../../hooks/useTickerCandles.js';
import { ContractTapeChart } from '../charts/ContractTapeChart.js';
import { TickerNetFlowChart } from '../charts/TickerNetFlowChart.js';
import type { IntervalBAFeedAlert } from '../../hooks/useIntervalBAFeed.js';

interface IntervalBARowProps {
  alert: IntervalBAFeedAlert;
  /** YYYY-MM-DD CT date of the parent's picker — used for tape/flow fetches. */
  date: string;
  /** Whether the picker's date is today (drives polling on the lazy hooks). */
  marketOpen: boolean;
}

const uwContractUrl = (chain: string): string =>
  `https://unusualwhales.com/flow/option_chains?chain=${encodeURIComponent(chain)}`;

const formatTimeCT = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

const formatPremium = (n: number): string => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`;
  return `$${n.toFixed(0)}`;
};

const formatSignedPremium = (n: number): string => {
  const sign = n >= 0 ? '+' : '−';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const formatVol = (n: number): string => {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
};

const formatDollar = (n: number): string => {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
};

const formatStrike = (n: number): string =>
  Number.isInteger(n) ? n.toString() : n.toFixed(0);

/**
 * Pretty-print an OTM/ITM distance as a percentage of spot. Tight
 * decimals close to zero so the user sees fractional-percent moves;
 * coarser for deeper distances where the magnitude matters more than
 * precision.
 */
const formatMoneynessPct = (pct: number): string => {
  const abs = Math.abs(pct);
  if (abs < 1) return `${abs.toFixed(2)}%`;
  if (abs < 10) return `${abs.toFixed(1)}%`;
  return `${abs.toFixed(0)}%`;
};

/**
 * Derive moneyness state from spot + strike + option type. The signed
 * pct convention: positive = ITM, negative = OTM. We treat anything
 * within ±0.05% of strike as ATM since same-strike rounding noise
 * isn't a meaningful directional bet.
 */
type Moneyness = {
  state: 'ITM' | 'OTM' | 'ATM';
  pct: number;
  label: string;
  cls: string;
  tooltip: string;
};

function getMoneyness(
  spot: number,
  strike: number,
  optionType: 'C' | 'P',
): Moneyness {
  const signed =
    optionType === 'C'
      ? ((spot - strike) / spot) * 100
      : ((strike - spot) / spot) * 100;
  const abs = Math.abs(signed);
  if (abs <= 0.05) {
    return {
      state: 'ATM',
      pct: signed,
      label: 'ATM',
      cls: 'border-neutral-500/40 bg-neutral-800/60 text-neutral-200',
      tooltip: `ATM — spot ${spot.toFixed(2)} is within ±0.05% of strike ${strike}.`,
    };
  }
  if (signed > 0) {
    return {
      state: 'ITM',
      pct: signed,
      label: `ITM ${formatMoneynessPct(signed)}`,
      cls: 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200',
      tooltip:
        optionType === 'C'
          ? `Call is ITM by ${formatMoneynessPct(signed)} — spot ${spot.toFixed(2)} > strike ${strike}.`
          : `Put is ITM by ${formatMoneynessPct(signed)} — spot ${spot.toFixed(2)} < strike ${strike}.`,
    };
  }
  return {
    state: 'OTM',
    pct: signed,
    label: `OTM ${formatMoneynessPct(signed)}`,
    cls: 'border-amber-500/40 bg-amber-950/30 text-amber-200',
    tooltip:
      optionType === 'C'
        ? `Call is OTM by ${formatMoneynessPct(signed)} — spot ${spot.toFixed(2)} < strike ${strike}. Needs ${(strike - spot).toFixed(2)} pts of upside to go ITM.`
        : `Put is OTM by ${formatMoneynessPct(signed)} — spot ${spot.toFixed(2)} > strike ${strike}. Needs ${(spot - strike).toFixed(2)} pts of downside to go ITM.`,
  };
}

const SEVERITY_STYLES: Record<
  IntervalBAFeedAlert['severity'],
  { stripe: string; badge: string; label: string; tooltip: string }
> = {
  extreme: {
    stripe: 'border-l-rose-400',
    badge: 'bg-rose-500/20 text-rose-200 border border-rose-500/40',
    label: 'EXTREME',
    tooltip:
      'EXTREME — bucket total premium ≥ $1M. The highest tier; an aggregate this large in a 5-min ask-side bucket is structurally rare for SPX/SPXW/SPY/QQQ.',
  },
  critical: {
    stripe: 'border-l-orange-400',
    badge: 'bg-orange-500/20 text-orange-200 border border-orange-500/40',
    label: 'CRITICAL',
    tooltip:
      'CRITICAL — bucket total premium $500K–$1M. Above the noise floor; meaningful concentration of ask-side buying.',
  },
  warning: {
    stripe: 'border-l-amber-400',
    badge: 'bg-amber-500/20 text-amber-200 border border-amber-500/40',
    label: 'WARNING',
    tooltip:
      'WARNING — bucket total premium $250K–$500K. Cleared the $250K floor + ≥75% ask ratio, but smaller-tier conviction than CRITICAL/EXTREME.',
  },
};

export const IntervalBARow = memo(function IntervalBARow({
  alert,
  date,
  marketOpen,
}: Readonly<IntervalBARowProps>) {
  const sev = SEVERITY_STYLES[alert.severity];
  const isCall = alert.option_type === 'C';
  const sideBadge = isCall
    ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
    : 'bg-rose-500/20 text-rose-200 border border-rose-500/40';
  const flags: string[] = [];
  if (alert.top_trade_is_sweep) flags.push('sweep');
  if (alert.top_trade_is_floor) flags.push('floor');

  const moneyness = useMemo(
    () =>
      alert.underlying_price != null
        ? getMoneyness(alert.underlying_price, alert.strike, alert.option_type)
        : null,
    [alert.underlying_price, alert.strike, alert.option_type],
  );

  const [expanded, setExpanded] = useState(false);

  const tape = useContractTape({
    chain: alert.option_chain,
    date,
    enabled: expanded,
    marketOpen,
  });
  // Memo for stable identity — `tapeStats` lists `tapeSeries` as a
  // useMemo dep, so a fresh `[]` per render would force re-computation.
  const tapeSeries = useMemo(() => tape.data?.series ?? [], [tape.data]);
  const netFlow = useNetFlowHistory({
    ticker: alert.ticker,
    date,
    enabled: expanded,
    marketOpen,
  });
  // Memo for stable identity — `flowStats` lists `netFlowSeries` as a
  // useMemo dep, so a fresh `[]` per render would force re-computation.
  const netFlowSeries = useMemo(
    () => netFlow.data?.series ?? [],
    [netFlow.data],
  );
  const tickerCandles = useTickerCandles({
    ticker: alert.ticker,
    date,
    enabled: expanded,
    marketOpen,
  });
  const candles = tickerCandles.data?.candles ?? [];
  const previousClose = tickerCandles.data?.previousClose ?? null;

  const tapeStats = useMemo(() => {
    if (tapeSeries.length === 0) return null;
    let bid = 0;
    let ask = 0;
    let mid = 0;
    let noSide = 0;
    let priceVolSum = 0;
    let volSum = 0;
    for (const r of tapeSeries) {
      bid += r.bidVol;
      ask += r.askVol;
      mid += r.midVol;
      noSide += r.noSideVol;
      if (r.avgPrice != null && Number.isFinite(r.avgPrice) && r.totalVol > 0) {
        priceVolSum += r.avgPrice * r.totalVol;
        volSum += r.totalVol;
      }
    }
    return {
      bid,
      ask,
      mid,
      noSide,
      total: bid + ask + mid + noSide,
      avgFill: volSum > 0 ? priceVolSum / volSum : null,
    };
  }, [tapeSeries]);

  const flowStats = useMemo(() => {
    if (netFlowSeries.length === 0) return null;
    const last = netFlowSeries.at(-1);
    if (last == null) return null;
    return {
      cumNcp: last.cumNcp,
      cumNpp: last.cumNpp,
      diff: last.cumNcp - last.cumNpp,
    };
  }, [netFlowSeries]);

  return (
    <div
      className={`rounded-md border border-l-4 border-neutral-800 bg-neutral-950/40 font-mono text-xs ${sev.stripe}`}
    >
      {/* Summary line — original single-row layout. */}
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        {/* Time CT */}
        <span className="text-neutral-400">{formatTimeCT(alert.fired_at)}</span>

        {/* Severity pill */}
        <span
          title={sev.tooltip}
          className={`cursor-help rounded px-1.5 py-0.5 font-sans text-[9px] font-bold ${sev.badge}`}
        >
          {sev.label}
        </span>

        {/* Contract — ticker + strike + type pill + moneyness */}
        <span className="flex items-center gap-1.5">
          <span className="font-sans text-[10px] font-semibold text-neutral-300">
            {alert.ticker}
          </span>
          <span className="text-neutral-100">{formatStrike(alert.strike)}</span>
          <span
            title={
              isCall
                ? 'CALL — ask-side buyers paid up for upside calls. Bullish directional bet.'
                : 'PUT — ask-side buyers paid up for downside puts. Bearish directional bet.'
            }
            className={`cursor-help rounded px-1.5 py-0.5 font-sans text-[10px] font-bold ${sideBadge}`}
          >
            {isCall ? 'CALL' : 'PUT'}
          </span>
          {moneyness && (
            <span
              title={moneyness.tooltip}
              className={`cursor-help rounded border px-1.5 py-0.5 font-sans text-[10px] font-bold ${moneyness.cls}`}
              aria-label={moneyness.tooltip}
            >
              {moneyness.label}
            </span>
          )}
        </span>

        {/* Confluence partners pill — only render when populated. */}
        {alert.confluence_tickers.length > 0 && (
          <span
            title={`Cross-symbol confluence — ${alert.confluence_tickers.join(' + ')} fired same-direction within ~90s of this alert. CALL hit-rate lifts from 53% solo to 61% with at least one partner (per 2026-05-12 backfill analysis).`}
            className="inline-flex cursor-help items-center gap-0.5 rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 font-sans text-[10px] font-bold text-sky-200"
          >
            {[...alert.confluence_tickers]
              .sort()
              .map((t) => `+${t}`)
              .join(' ')}
          </span>
        )}

        {/* Ratio */}
        <span
          title="Ask-side premium ÷ total bucket premium. ≥75% is the structural-anomaly threshold for SPX/SPY/QQQ — informed-flow conviction signature."
          className="ml-auto flex cursor-help flex-col items-end"
        >
          <span className="text-neutral-100">
            {alert.ratio_pct.toFixed(0)}%
          </span>
          <span className="text-[10px] text-neutral-500">ratio</span>
        </span>

        {/* Total premium */}
        <span className="flex flex-col items-end">
          <span className="text-neutral-100">
            {formatPremium(alert.total_premium)}
          </span>
          <span className="text-[10px] text-neutral-500">
            {alert.trade_count} {alert.trade_count === 1 ? 'trade' : 'trades'}
          </span>
        </span>

        {/* Top trade */}
        {alert.top_trade_premium != null && (
          <span className="flex flex-col items-end">
            <span className="text-neutral-100">
              {formatPremium(alert.top_trade_premium)}
            </span>
            <span className="text-[10px] text-neutral-500">
              top{flags.length > 0 ? ` · ${flags.join(' ')}` : ''}
            </span>
          </span>
        )}

        {/* Underlying spot */}
        {alert.underlying_price != null && (
          <span className="flex flex-col items-end text-neutral-400">
            <span>{alert.underlying_price.toFixed(0)}</span>
            <span className="text-[10px] text-neutral-500">spx</span>
          </span>
        )}

        {/* Expand toggle — same affordance as Lottery / Silent Boom rows. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-400 hover:text-white"
          title={
            expanded
              ? 'Collapse contract + net-flow charts'
              : 'Expand to show contract tape and ticker net-flow charts'
          }
          aria-expanded={expanded}
          aria-label={
            expanded ? 'Collapse charts' : `Expand charts for ${alert.ticker}`
          }
        >
          {expanded ? '▾ collapse' : '▸ expand'}
        </button>

        {/* UW contract link */}
        <a
          href={uwContractUrl(alert.option_chain)}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on Unusual Whales"
          className="rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
          aria-label={`Open ${alert.option_chain} on Unusual Whales`}
        >
          ↗
        </a>
      </div>

      {/* Expanded panel — twin UW-style chart panels. Lazy-loaded via
          the hooks' `enabled` gate; collapsed rows do zero network. */}
      {expanded && (
        <div className="grid gap-3 border-t border-neutral-800 px-3 py-3 md:grid-cols-2">
          {/* CONTRACT TAPE PANEL */}
          <div className="rounded-md border border-neutral-800/80 bg-neutral-950/40 p-2.5">
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-semibold tracking-[0.08em] text-neutral-500 uppercase">
                  contract
                </span>
                <span className="font-mono text-xs font-semibold text-neutral-100">
                  {alert.ticker}
                </span>
                <span className="font-mono text-xs text-neutral-300">
                  {formatStrike(alert.strike)}
                </span>
                <span
                  className={`rounded border px-1 py-px text-[10px] leading-none font-bold ${sideBadge}`}
                  title={isCall ? 'Call' : 'Put'}
                >
                  {isCall ? 'C' : 'P'}
                </span>
                {moneyness && (
                  <span
                    className={`rounded border px-1 py-px font-mono text-[10px] leading-none ${moneyness.cls}`}
                    title={moneyness.tooltip}
                  >
                    {moneyness.label}
                  </span>
                )}
                <span className="text-neutral-600">·</span>
                <span className="font-mono text-xs text-neutral-300">
                  {alert.expiry}
                </span>
              </div>
              <span className="text-[10px] tracking-wide text-neutral-600 uppercase">
                bid · ask · mid + VWAP
              </span>
            </div>
            {tapeStats != null && tapeStats.total > 0 && (
              <div className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-neutral-400">
                <span>
                  <span className="text-red-300">Bid</span>{' '}
                  <span className="text-neutral-200">
                    {formatVol(tapeStats.bid)}
                  </span>
                </span>
                <span>
                  <span className="text-blue-300">Mid</span>{' '}
                  <span className="text-neutral-200">
                    {formatVol(tapeStats.mid)}
                  </span>
                </span>
                <span>
                  <span className="text-green-300">Ask</span>{' '}
                  <span className="text-neutral-200">
                    {formatVol(tapeStats.ask)}
                  </span>
                </span>
                {tapeStats.avgFill != null && (
                  <span>
                    Avg fill{' '}
                    <span className="text-neutral-200">
                      {formatDollar(tapeStats.avgFill)}
                    </span>
                  </span>
                )}
                <span className="ml-auto text-neutral-500">
                  total {formatVol(tapeStats.total)}
                </span>
              </div>
            )}
            {tape.loading && tapeSeries.length === 0 ? (
              <div className="text-[10px] text-neutral-500">Loading tape…</div>
            ) : tape.error ? (
              <div className="text-[10px] text-red-300">
                tape error: {tape.error}
              </div>
            ) : (
              <ContractTapeChart
                series={tapeSeries}
                markerTs={alert.fired_at}
                ariaLabel={`${alert.option_chain} per-minute tape`}
              />
            )}
          </div>

          {/* NET FLOW PANEL */}
          <div className="rounded-md border border-neutral-800/80 bg-neutral-950/40 p-2.5">
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-semibold tracking-[0.08em] text-neutral-500 uppercase">
                  net flow
                </span>
                <span className="font-mono text-xs font-semibold text-neutral-100">
                  {alert.ticker}
                </span>
                <span className="text-[10px] text-neutral-500">
                  cumulative · session-to-date
                </span>
              </div>
              <span className="text-[10px] tracking-wide text-neutral-600 uppercase">
                price · NCP · NPP · net vol
              </span>
            </div>
            {flowStats != null && (
              <div className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-neutral-400">
                {candles.length > 0 && (
                  <span>
                    <span className="text-amber-300">spot</span>{' '}
                    <span className="text-neutral-200">
                      {candles.at(-1)!.close.toFixed(2)}
                    </span>
                  </span>
                )}
                <span>
                  <span className="text-green-300">NCP</span>{' '}
                  <span className="text-neutral-200">
                    {formatSignedPremium(flowStats.cumNcp)}
                  </span>
                </span>
                <span>
                  <span className="text-red-300">NPP</span>{' '}
                  <span className="text-neutral-200">
                    {formatSignedPremium(flowStats.cumNpp)}
                  </span>
                </span>
                <span>
                  Δ{' '}
                  <span
                    className={
                      flowStats.diff >= 0 ? 'text-green-300' : 'text-red-300'
                    }
                  >
                    {formatSignedPremium(flowStats.diff)}
                  </span>
                </span>
              </div>
            )}
            {netFlow.loading && netFlowSeries.length === 0 ? (
              <div className="text-[10px] text-neutral-500">
                Loading net flow…
              </div>
            ) : netFlow.error ? (
              <div className="text-[10px] text-red-300">
                net flow error: {netFlow.error}
              </div>
            ) : (
              <TickerNetFlowChart
                series={netFlowSeries}
                candles={candles}
                previousClose={previousClose}
                markerTs={alert.fired_at}
                ariaLabel={`${alert.ticker} cumulative net call/put premium with stock price overlay`}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});
