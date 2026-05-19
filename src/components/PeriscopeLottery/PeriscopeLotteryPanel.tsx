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

import { useMemo, useState } from 'react';
import { SectionBox } from '../ui';
import { usePeriscopeLotteryFeed } from '../../hooks/usePeriscopeLotteryFeed.js';
import { getETDateStr } from '../../utils/timezone.js';
import { buildSpxwOcc, spxwUwChainUrl } from './buildSpxwOcc.js';
import type { LotteryFireType, PeriscopeLotteryFire } from './types.js';

interface Props {
  marketOpen: boolean;
  /**
   * When true the panel starts collapsed (chevron pointing right).
   * Set on at-a-glance monitors that often show "0 fires" — the user
   * opts in by clicking to expand. Other panels (Periscope, Settlement)
   * default to expanded because they answer the user's primary question.
   */
  defaultCollapsed?: boolean;
}

export function PeriscopeLotteryPanel({
  marketOpen,
  defaultCollapsed,
}: Props): React.ReactElement {
  const today = useMemo(() => getETDateStr(new Date()), []);
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const historical = selectedDate < today;
  const { fires, loading, error, fetchedAt } = usePeriscopeLotteryFeed({
    date: selectedDate,
    marketOpen,
    historical,
    fireType: 'both',
    limit: 500,
  });

  const calls = useMemo(
    () => fires.filter((f) => f.fireType === 'call_lottery'),
    [fires],
  );
  const puts = useMemo(
    () => fires.filter((f) => f.fireType === 'put_lottery'),
    [fires],
  );

  const headerRight = (
    <div className="flex items-center gap-2">
      <label
        className="text-muted font-sans text-[10px]"
        htmlFor="periscope-lottery-date"
      >
        Date
      </label>
      <input
        id="periscope-lottery-date"
        type="date"
        value={selectedDate}
        max={today}
        onChange={(e) => setSelectedDate(e.target.value || today)}
        className="border-edge bg-input text-primary rounded-md border px-2 py-0.5 font-mono text-[11px]"
        aria-label="Pick a date to view Periscope Lottery fires"
      />
      <FreshnessChip fetchedAt={fetchedAt} loading={loading} />
    </div>
  );

  return (
    <SectionBox
      label="Periscope Lottery"
      collapsible
      defaultCollapsed={defaultCollapsed}
      headerRight={headerRight}
    >
      <p className="text-muted -mt-1 mb-3 font-sans text-[10px]">
        0DTE SPXW · MM gamma + charm extremes ·{' '}
        {historical
          ? 'historical — outcomes locked'
          : 'auto-refreshes every 60s'}
      </p>

      {error && (
        <div
          role="alert"
          className="border-danger bg-danger/10 text-danger mb-2 rounded-md border px-3 py-2 font-sans text-xs"
        >
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <LotteryColumn
          side="call_lottery"
          fires={calls}
          loading={loading}
          date={selectedDate}
        />
        <LotteryColumn
          side="put_lottery"
          fires={puts}
          loading={loading}
          date={selectedDate}
        />
      </div>
    </SectionBox>
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
  // Side accent — call = success/green, put = danger/red. Uses the
  // theme tokens (var(--color-success/danger)) so dark + light themes
  // both render correctly.
  const accent = isCall ? 'text-success' : 'text-danger';
  const sideLabel = isCall ? 'call' : 'put';

  return (
    <article
      className="border-edge bg-surface rounded-md border p-3"
      aria-labelledby={`periscope-lottery-${side}`}
    >
      <header className="mb-2 flex items-center justify-between">
        <h4
          id={`periscope-lottery-${side}`}
          className={`font-serif text-sm font-semibold tracking-wide ${accent}`}
        >
          {label}
        </h4>
        <span className="bg-chip-bg text-secondary border-edge rounded-full border px-2 py-0.5 font-mono text-[10px]">
          {fires.length} fire{fires.length === 1 ? '' : 's'}
        </span>
      </header>

      {fires.length === 0 ? (
        <p className="text-muted font-sans text-[11px]">
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
      className="border-edge bg-surface-alt rounded-md border p-2"
      data-testid="periscope-lottery-row"
    >
      <div className="flex items-baseline justify-between gap-2">
        <a
          href={spxwUwChainUrl(occ)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:text-accent font-mono text-sm font-semibold hover:underline"
        >
          {fire.tradeStrike}
          {sideLabel === 'call' ? 'C' : 'P'}
        </a>
        <span className="text-muted font-mono text-[10px]">{fireTimeCt}</span>
      </div>

      <dl className="text-secondary mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px]">
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
          <Badge tone="strong">V4</Badge>
        ) : fire.v3StrictPass ? (
          <Badge tone="muted">V3</Badge>
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
  tone: 'strong' | 'muted';
}): React.ReactElement {
  // 'strong' = V4 (background-accent), 'muted' = V3 (chip styling).
  // Both pull from theme tokens so light + dark render correctly.
  const cls =
    tone === 'strong'
      ? 'border-accent bg-accent-bg text-accent'
      : 'border-edge bg-chip-bg text-tertiary';
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
  // Outcome pill: green when peak hit ≥ +50% (R ≥ 0.5), neutral chip
  // otherwise. Theme tokens (success vs chip) keep the contrast valid
  // in both light + dark.
  const tone = ok
    ? 'border-success bg-success/15 text-success'
    : 'border-edge bg-chip-bg text-tertiary';
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
      className="bg-chip-bg text-secondary border-edge rounded-full border px-2 py-0.5 font-sans text-[10px] font-medium whitespace-nowrap"
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
