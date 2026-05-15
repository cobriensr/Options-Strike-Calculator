/**
 * Per-ticker card. Renders one of:
 *   - waiting (window hasn't opened / no data yet)
 *   - slice 1 in progress (showing live tickets so far)
 *   - slice 2 in progress (slice 1 locked, awaiting confirm)
 *   - signal fired (BIG action card)
 *   - signal blocked (shows the blocking reason)
 */

import type {
  OpeningFlowSlice1,
  OpeningFlowTicket,
  OpeningFlowTickerPayload,
  WindowStatus,
} from '../../hooks/useOpeningFlowSignal.js';

interface Props {
  ticker: 'SPY' | 'QQQ';
  payload: OpeningFlowTickerPayload | null;
  windowStatus: WindowStatus;
  stopPct: number;
  exitMinutesFromEntry: number;
  loading: boolean;
}

const usd = (n: number): string =>
  `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const usdM = (n: number): string => `$${(n / 1_000_000).toFixed(2)}M`;

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

export function SignalCard(props: Props): React.ReactElement {
  const {
    ticker,
    payload,
    windowStatus,
    stopPct,
    exitMinutesFromEntry,
    loading,
  } = props;

  return (
    <article
      className="rounded border border-slate-700 bg-slate-950/60 p-3"
      aria-labelledby={`flow-${ticker}`}
    >
      <header className="mb-2 flex items-center justify-between">
        <h3
          id={`flow-${ticker}`}
          className="text-base font-semibold tracking-wide text-slate-100"
        >
          {ticker}
        </h3>
        {loading && (
          <span className="text-xs text-slate-500" aria-live="polite">
            updating…
          </span>
        )}
      </header>

      {payload === null || windowStatus === 'before_open' ? (
        <p className="text-xs text-slate-400">
          Waiting for the 08:30 CT slice to open.
        </p>
      ) : (
        <CardBody
          payload={payload}
          windowStatus={windowStatus}
          stopPct={stopPct}
          exitMinutesFromEntry={exitMinutesFromEntry}
        />
      )}
    </article>
  );
}

function CardBody({
  payload,
  windowStatus,
  stopPct,
  exitMinutesFromEntry,
}: {
  payload: OpeningFlowTickerPayload;
  windowStatus: WindowStatus;
  stopPct: number;
  exitMinutesFromEntry: number;
}): React.ReactElement {
  const { slice1, slice2, signal } = payload;

  if (slice1 === null || slice1.tickets.length === 0) {
    return (
      <p className="text-xs text-slate-400">No $1M+ tickets yet in slice 1.</p>
    );
  }

  return (
    <div className="space-y-3">
      <BiasLine slice1={slice1} slice2={slice2} />
      {signal && signal.fired ? (
        <ActionBlock
          contract={signal.contract}
          side={signal.side}
          entryPrice={signal.entryPrice}
          stopPct={stopPct}
          exitMinutesFromEntry={exitMinutesFromEntry}
        />
      ) : (
        <BlockedBlock
          windowStatus={windowStatus}
          reason={signal && !signal.fired ? signal.reason : null}
        />
      )}
      <TicketBreakdown slice1={slice1} />
    </div>
  );
}

function BiasLine({
  slice1,
  slice2,
}: {
  slice1: OpeningFlowSlice1;
  slice2: OpeningFlowTickerPayload['slice2'];
}): React.ReactElement {
  const biasLabel =
    slice1.biasSide === null ? '—' : slice1.biasSide.toUpperCase();
  const top3Mark = slice1.top3SameSide ? '✓' : '✗';
  const top3Color = slice1.top3SameSide ? 'text-emerald-300' : 'text-amber-300';
  const s2Share = slice2?.biasShare;
  const s2Confirms = slice2?.confirms ?? false;
  const s2Color = s2Confirms ? 'text-emerald-300' : 'text-amber-300';

  return (
    <p className="text-xs text-slate-300">
      Bias: <span className="font-medium text-slate-100">{biasLabel}</span>{' '}
      <span className="text-slate-400">({pct(slice1.biasRatio)})</span>
      <span className="mx-2 text-slate-600">·</span>
      <span className={top3Color}>Top-3 {top3Mark}</span>
      <span className="mx-2 text-slate-600">·</span>
      <span className={s2Color}>
        Slice-2 {s2Share == null ? '—' : pct(s2Share)}
      </span>
    </p>
  );
}

function ActionBlock({
  contract,
  side,
  entryPrice,
  stopPct,
  exitMinutesFromEntry,
}: {
  contract: OpeningFlowTicket;
  side: 'call' | 'put';
  entryPrice: number;
  stopPct: number;
  exitMinutesFromEntry: number;
}): React.ReactElement {
  const sideLabel = side.toUpperCase();
  const strikeLabel = `${contract.strike}${side === 'call' ? 'C' : 'P'}`;
  const stopPrice = entryPrice * (1 - stopPct);
  return (
    <div className="rounded border border-emerald-700 bg-emerald-950/40 p-3">
      <p className="text-xs font-medium tracking-wide text-emerald-300 uppercase">
        Trade
      </p>
      <p className="mt-1 text-base font-semibold text-emerald-100">
        BUY {strikeLabel} 0DTE ({sideLabel})
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-200">
        <dt className="text-slate-400">Entry (slice-1 avg)</dt>
        <dd className="text-right tabular-nums">{usd(entryPrice)}</dd>
        <dt className="text-slate-400">Volume</dt>
        <dd className="text-right tabular-nums">
          {contract.volume.toLocaleString()} contracts
        </dd>
        <dt className="text-slate-400">Stop ({pct(stopPct)})</dt>
        <dd className="text-right tabular-nums">{usd(stopPrice)}</dd>
        <dt className="text-slate-400">Exit time</dt>
        <dd className="text-right tabular-nums">
          +{exitMinutesFromEntry}m from 08:40 CT
        </dd>
      </dl>
    </div>
  );
}

function BlockedBlock({
  windowStatus,
  reason,
}: {
  windowStatus: WindowStatus;
  reason: string | null;
}): React.ReactElement {
  if (windowStatus === 'slice1') {
    return (
      <p className="rounded bg-slate-800/60 px-2 py-1 text-xs text-slate-300">
        Slice 1 in progress. Final read at 08:35 CT, then slice 2 confirm.
      </p>
    );
  }
  if (windowStatus === 'slice2') {
    return (
      <p className="rounded bg-slate-800/60 px-2 py-1 text-xs text-slate-300">
        Slice 1 complete. Slice 2 in progress — confirm at 08:40 CT.
      </p>
    );
  }
  const label = describeReason(reason);
  return (
    <p className="rounded border border-amber-800 bg-amber-950/40 px-2 py-1 text-xs text-amber-200">
      No signal: {label}
    </p>
  );
}

function describeReason(reason: string | null): string {
  switch (reason) {
    case 'no_tickets':
      return 'no $1M+ tickets qualified';
    case 'top3_mixed':
      return 'top-3 tickets split across both sides (consensus failed)';
    case 's2_below_60':
      return 'slice-2 bias share below 60% (confirm failed)';
    case 'window_not_complete':
      return 'slice 2 still in progress';
    default:
      return 'rule did not fire';
  }
}

function TicketBreakdown({
  slice1,
}: {
  slice1: OpeningFlowSlice1;
}): React.ReactElement {
  return (
    <details className="text-xs text-slate-300">
      <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
        Slice 1 tickets ({slice1.tickets.length} qualifying)
      </summary>
      <ul className="mt-1 space-y-0.5 font-mono">
        {slice1.tickets.map((t) => (
          <li
            key={`${t.strike}-${t.side}`}
            className="grid grid-cols-[auto_1fr_auto] gap-x-2 tabular-nums"
          >
            <span className="text-slate-100">
              {t.strike}
              {t.side === 'call' ? 'C' : 'P'}
            </span>
            <span className="text-slate-400">{usdM(t.premium)}</span>
            <span className="text-right text-slate-400">
              {t.volume.toLocaleString()}v
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
