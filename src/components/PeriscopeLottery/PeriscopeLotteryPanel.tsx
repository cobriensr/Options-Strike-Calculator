/**
 * PeriscopeLotteryPanel — two-column live monitor for Periscope-derived
 * 0DTE lottery fires (call side on the left, put side on the right).
 *
 * Backed by /api/periscope-lottery-feed and polled every 60s during
 * market hours. Each fire shows enough context (strike, distance, |γ|
 * rank, GEX$, V3/V4 badges, realized outcomes when locked) to act
 * directly without bouncing back to UW.
 *
 * Spec: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 */

import { useMemo } from 'react';
import { usePeriscopeLotteryFeed } from '../../hooks/usePeriscopeLotteryFeed.js';
import { getETDateStr } from '../../utils/timezone.js';
import { buildSpxwOcc, spxwUwChainUrl } from './buildSpxwOcc.js';
import type { LotteryFireType, PeriscopeLotteryFire } from './types.js';

interface Props {
  marketOpen: boolean;
}

export function PeriscopeLotteryPanel({
  marketOpen,
}: Props): React.ReactElement {
  const today = useMemo(() => getETDateStr(new Date()), []);
  const { fires, loading, error, fetchedAt } = usePeriscopeLotteryFeed({
    date: today,
    marketOpen,
    fireType: 'both',
    limit: 50,
  });

  const calls = useMemo(
    () => fires.filter((f) => f.fireType === 'call_lottery'),
    [fires],
  );
  const puts = useMemo(
    () => fires.filter((f) => f.fireType === 'put_lottery'),
    [fires],
  );

  return (
    <section aria-labelledby="periscope-lottery-heading">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id="periscope-lottery-heading"
            className="text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase"
          >
            Periscope Lottery
          </h3>
          <p className="text-muted mt-0.5 font-sans text-[10px]">
            0DTE SPXW · MM gamma + charm extremes · auto-refreshes every 60s
          </p>
        </div>
        <FreshnessChip fetchedAt={fetchedAt} loading={loading} />
      </header>

      {error && (
        <div
          role="alert"
          className="mb-2 rounded border border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-200"
        >
          {error}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <LotteryColumn
          side="call_lottery"
          fires={calls}
          loading={loading}
          date={today}
        />
        <LotteryColumn
          side="put_lottery"
          fires={puts}
          loading={loading}
          date={today}
        />
      </div>
    </section>
  );
}

function LotteryColumn({
  side,
  fires,
  loading,
  date,
}: {
  side: LotteryFireType;
  fires: PeriscopeLotteryFire[];
  loading: boolean;
  date: string;
}): React.ReactElement {
  const isCall = side === 'call_lottery';
  const label = isCall ? 'Call Lottery' : 'Put Lottery';
  const accent = isCall ? 'text-emerald-300' : 'text-rose-300';
  const sideLabel = isCall ? 'call' : 'put';

  return (
    <article
      className="rounded border border-slate-700 bg-slate-950/60 p-3"
      aria-labelledby={`periscope-lottery-${side}`}
    >
      <header className="mb-2 flex items-center justify-between">
        <h4
          id={`periscope-lottery-${side}`}
          className={`text-sm font-semibold tracking-wide ${accent}`}
        >
          {label}
        </h4>
        <span className="text-muted font-sans text-[10px]">
          {fires.length} fire{fires.length === 1 ? '' : 's'}
        </span>
      </header>

      {fires.length === 0 ? (
        <p className="text-secondary font-sans text-[11px]">
          {loading
            ? 'Loading…'
            : 'No fires today yet — panel updates as Periscope publishes new 10-min slices.'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {fires.map((fire) => (
            <LotteryRow
              key={fire.id}
              fire={fire}
              date={date}
              sideLabel={sideLabel}
            />
          ))}
        </ul>
      )}
    </article>
  );
}

function LotteryRow({
  fire,
  date,
  sideLabel,
}: {
  fire: PeriscopeLotteryFire;
  date: string;
  sideLabel: 'call' | 'put';
}): React.ReactElement {
  const occ = buildSpxwOcc(date, sideLabel, fire.tradeStrike);
  const fireTimeCt = fmtCt(fire.fireTime);
  const distSign = sideLabel === 'call' ? '+' : '−';
  const gammaAbs = Math.abs(fire.greekPost);
  const gexDollarsB =
    fire.gexDollars == null ? null : fire.gexDollars / 1_000_000_000;

  return (
    <li
      className="rounded border border-slate-800 bg-slate-900/50 p-2"
      data-testid="periscope-lottery-row"
    >
      <div className="flex items-baseline justify-between gap-2">
        <a
          href={spxwUwChainUrl(occ)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary font-mono text-sm font-semibold hover:underline"
        >
          {fire.tradeStrike}
          {sideLabel === 'call' ? 'C' : 'P'}
        </a>
        <span className="text-muted font-mono text-[10px]">{fireTimeCt}</span>
      </div>

      <dl className="text-secondary mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px]">
        <div>
          <dt className="text-muted inline">Δstrike </dt>
          <dd className="inline">
            {distSign}
            {fire.strikeDist.toFixed(1)}
          </dd>
        </div>
        <div>
          <dt className="text-muted inline">|γ| </dt>
          <dd className="inline">{fmtCompact(gammaAbs)}</dd>
        </div>
        <div>
          <dt className="text-muted inline">|Δγ| </dt>
          <dd className="inline">{fmtCompact(Math.abs(fire.greekDelta))}</dd>
        </div>
        {gexDollarsB != null && (
          <div>
            <dt className="text-muted inline">GEX$ </dt>
            <dd className="inline">
              {gexDollarsB >= 0 ? '+' : ''}
              {gexDollarsB.toFixed(2)}B
            </dd>
          </div>
        )}
        {fire.entryPx != null && (
          <div>
            <dt className="text-muted inline">entry </dt>
            <dd className="inline">${fire.entryPx.toFixed(2)}</dd>
          </div>
        )}
        {fire.qqqNetPremBalance30m != null && (
          <div>
            <dt className="text-muted inline">QQQ bal </dt>
            <dd className="inline">{fire.qqqNetPremBalance30m.toFixed(2)}</dd>
          </div>
        )}
      </dl>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {fire.v4Badge ? (
          <Badge tone="emerald">V4</Badge>
        ) : fire.v3StrictPass ? (
          <Badge tone="sky">V3</Badge>
        ) : null}
        {fire.outcomeLocked && (
          <OutcomePill
            peakPct={fire.peakPct}
            realizedRPeak={fire.realizedRPeak}
            realizedREod={fire.realizedREod}
          />
        )}
      </div>
    </li>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'emerald' | 'sky';
}): React.ReactElement {
  const cls =
    tone === 'emerald'
      ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800'
      : 'bg-sky-950/60 text-sky-300 border-sky-800';
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-sans text-[9px] font-bold tracking-wider uppercase ${cls}`}
    >
      {children}
    </span>
  );
}

function OutcomePill({
  peakPct,
  realizedRPeak,
  realizedREod,
}: {
  peakPct: number | null;
  realizedRPeak: number | null;
  realizedREod: number | null;
}): React.ReactElement {
  const peakLabel = peakPct == null ? '—' : `${Math.round(peakPct)}%`;
  const rPeakLabel =
    realizedRPeak == null ? '—' : `R=${realizedRPeak.toFixed(1)}`;
  const eodLabel = realizedREod == null ? '—' : `${realizedREod.toFixed(2)}R`;
  const ok = (realizedRPeak ?? -1) >= 0.5;
  const tone = ok
    ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800'
    : 'bg-slate-800 text-slate-300 border-slate-700';
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${tone}`}
      title={`peak ${peakLabel} (${rPeakLabel}) · eod ${eodLabel}`}
    >
      peak {peakLabel} · eod {eodLabel}
    </span>
  );
}

function FreshnessChip({
  fetchedAt,
  loading,
}: {
  fetchedAt: number | null;
  loading: boolean;
}): React.ReactElement {
  const label = loading
    ? 'Loading…'
    : fetchedAt == null
      ? 'Idle'
      : `Updated ${fmtCt(new Date(fetchedAt).toISOString())} CT`;
  return (
    <span
      className="bg-chip-bg text-secondary rounded-full px-2 py-0.5 font-sans text-[10px] font-medium whitespace-nowrap"
      aria-live="polite"
    >
      {label}
    </span>
  );
}

function fmtCt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}
