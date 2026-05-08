/**
 * PeriscopePanel — read-only display of the latest UW Periscope
 * MM-attributed exposure slot, scraped into `periscope_snapshots`
 * by the Railway scraper service.
 *
 * Replaces the screenshot-paste workflow: the same data the analyze
 * endpoint injects into Claude's prompt is rendered here so the user
 * can see what Claude is seeing without opening UW.
 *
 * Sections (in priority order — matches the periscope skill's
 * structural read):
 *   1. Cone bounds + breach status  → frames the day's expected move
 *   2. Gamma topology               → +γ ceiling/floor + −γ accel
 *   3. Charm flow                   → tally near spot + top extremes
 *   4. Vanna pressure               → vol-shock sensitivity
 *   5. Sign flips                   → orange-bar regime-flip equivalent
 *
 * Empty states are explicit: "no SPX spot yet", "scraper hasn't
 * inserted any slot yet" — never a blank panel.
 */

import { memo, useMemo } from 'react';
import { SectionBox } from '../ui';
import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import type {
  PeriscopeView,
  RankedRow,
  RankedRowSimple,
} from '../../hooks/usePeriscopeExposure';
import {
  computeTradePlan,
  type TradePlan,
  type Verdict,
} from '../../utils/periscope-trade-plan';

interface PeriscopePanelProps {
  view: PeriscopeView | null;
  emptyReason: 'no_spot' | 'no_slot' | null;
  asOf: string | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function fmtSigned(n: number): string {
  if (Math.abs(n) >= 1_000_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000)
    return `${n >= 0 ? '+' : ''}${(n / 1_000).toFixed(1)}K`;
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}`;
}

function fmtPts(pts: number): string {
  const sign = pts >= 0 ? '+' : '';
  return `${sign}${pts.toFixed(0)}`;
}

function colorForValue(v: number): string {
  if (v > 0) return theme.green;
  if (v < 0) return theme.red;
  return theme.textSecondary;
}

function RankedCell({ row }: { row: RankedRow | RankedRowSimple }) {
  const ptsLabel = 'ptsFromSpot' in row ? ` (${fmtPts(row.ptsFromSpot)})` : '';
  return (
    <span className="font-mono text-[12px]">
      <span style={{ color: theme.text }}>{row.strike}</span>{' '}
      <span style={{ color: colorForValue(row.value) }}>
        {fmtSigned(row.value)}
      </span>
      {ptsLabel && <span style={{ color: theme.textMuted }}>{ptsLabel}</span>}
    </span>
  );
}

function asymmetryLabel(pts: number): string {
  if (pts > 0) return 'lower-skewed (downside priced richer)';
  if (pts < 0) return 'upper-skewed (upside priced richer)';
  return 'symmetric';
}

function PeriscopePanelInner({
  view,
  emptyReason,
  asOf,
  isLoading,
  error,
  onRefresh,
}: PeriscopePanelProps) {
  const headerRight = (
    <div className="flex items-center gap-3">
      {asOf && (
        <span
          className="font-mono text-[10px]"
          style={{ color: theme.textMuted }}
        >
          {formatTimeCT(asOf, { fallback: '' })} CT
        </span>
      )}
      <button
        type="button"
        onClick={onRefresh}
        disabled={isLoading}
        className="rounded px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase disabled:opacity-50"
        style={{
          color: theme.accent,
          backgroundColor: theme.accentBg,
        }}
      >
        {isLoading ? '…' : 'refresh'}
      </button>
    </div>
  );

  let body: React.ReactNode;
  if (error) {
    body = (
      <p className="font-mono text-[12px]" style={{ color: theme.red }}>
        {error}
      </p>
    );
  } else if (view == null) {
    const message =
      emptyReason === 'no_spot'
        ? 'Waiting for SPX spot from index_candles_1m.'
        : 'Scraper has not inserted a Periscope slot for today yet. First slot lands ~5:50 CT during a normal session.';
    body = (
      <p className="font-mono text-[12px]" style={{ color: theme.textMuted }}>
        {message}
      </p>
    );
  } else {
    body = <PeriscopeBody view={view} />;
  }

  return (
    <SectionBox
      label="Periscope MM Exposure"
      headerRight={headerRight}
      collapsible
    >
      {body}
    </SectionBox>
  );
}

function PeriscopeBody({ view }: { view: PeriscopeView }) {
  const plan = useMemo(() => computeTradePlan(view), [view]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between font-mono text-[11px]">
        <span style={{ color: theme.textSecondary }}>
          Slot {formatTimeCT(view.capturedAt)} CT · {view.expiry}
        </span>
        <span style={{ color: theme.text }}>spot {view.spot.toFixed(2)}</span>
      </div>

      <TradePlanSection plan={plan} />

      {view.cone && <ConeSection view={view} />}
      <GammaSection view={view} />
      <CharmSection view={view} />
      {view.vanna.topByAbs.length > 0 && <VannaSection view={view} />}
      {view.signFlips.length > 0 && <SignFlipsSection view={view} />}
    </div>
  );
}

function verdictColor(v: Verdict): string {
  if (v === 'safe') return theme.green;
  if (v === 'conditional') return theme.caution;
  return theme.red;
}

function regimeColor(regime: TradePlan['regime']): string {
  if (regime === 'cone-breach-up') return theme.green;
  if (regime === 'cone-breach-down') return theme.red;
  if (regime === 'pin') return theme.accent;
  if (regime === 'drift-and-cap') return theme.text;
  return theme.textMuted;
}

function fmtLevel(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(0);
}

function TradePlanSection({ plan }: { plan: TradePlan }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-3"
      style={{
        borderColor: theme.border,
        backgroundColor: theme.surfaceAlt,
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3
          className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
          style={{ color: theme.textTertiary }}
        >
          Trade Plan
        </h3>
        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span
            className="rounded px-1.5 py-0.5 uppercase tracking-wider"
            style={{
              color: regimeColor(plan.regime),
              backgroundColor: `color-mix(in srgb, ${regimeColor(plan.regime)} 15%, transparent)`,
            }}
          >
            {plan.regime}
          </span>
          <span
            className="rounded px-1.5 py-0.5 uppercase tracking-wider"
            style={{
              color: theme.text,
              backgroundColor: theme.chipBg,
            }}
          >
            bias: {plan.bias}
          </span>
        </div>
      </div>

      <p
        className="font-mono text-[11px] leading-snug"
        style={{ color: theme.textSecondary }}
      >
        {plan.summary}
      </p>

      <DirectionalRow label="LONG" plan={plan.long} />
      <DirectionalRow label="SHORT" plan={plan.short} />

      {plan.waitZone != null && (
        <div className="flex items-baseline gap-2 font-mono text-[11px]">
          <span
            className="font-bold"
            style={{ color: theme.textTertiary }}
          >
            WAIT
          </span>
          <span style={{ color: theme.textMuted }}>{plan.waitZone}</span>
        </div>
      )}
    </div>
  );
}

function DirectionalRow({
  label,
  plan,
}: {
  label: string;
  plan: TradePlan['long'];
}) {
  const color = verdictColor(plan.verdict);
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[11px]">
      <div className="flex items-baseline gap-2">
        <span className="font-bold" style={{ color: theme.text }}>
          {label}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
          style={{
            color,
            backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
          }}
        >
          {plan.verdict}
        </span>
        {plan.verdict !== 'avoid' && (
          <span
            className="text-[10px]"
            style={{ color: theme.textSecondary }}
          >
            trigger {fmtLevel(plan.trigger)} · stop {fmtLevel(plan.stop)} ·
            target {fmtLevel(plan.target)}
          </span>
        )}
      </div>
      <span
        className="leading-snug"
        style={{ color: theme.textMuted }}
      >
        {plan.reason}
      </span>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
      style={{ color: theme.textTertiary }}
    >
      {children}
    </h3>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between">
      <span
        className="font-mono text-[11px]"
        style={{ color: theme.textSecondary }}
      >
        {label}
      </span>
      <span className="font-mono text-[12px]">{value}</span>
    </div>
  );
}

function ConeSection({ view }: { view: PeriscopeView }) {
  const cone = view.cone!;
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Straddle Cone</SectionHeader>
      <Row
        label="Bounds"
        value={
          <span style={{ color: theme.text }}>
            {cone.coneLower.toFixed(1)} — {cone.coneUpper.toFixed(1)} (
            {cone.coneWidth.toFixed(0)} pts)
          </span>
        }
      />
      <Row
        label="Asymmetry"
        value={
          <span style={{ color: theme.text }}>
            {fmtSigned(cone.asymmetryPts)} pts ·{' '}
            <span style={{ color: theme.textMuted }}>
              {asymmetryLabel(cone.asymmetryPts)}
            </span>
          </span>
        }
      />
      {view.breaches.length === 0 ? (
        <Row
          label="Breach"
          value={
            <span style={{ color: theme.textSecondary }}>
              none — {(cone.coneUpper - view.spot).toFixed(0)} pts to upper,{' '}
              {(view.spot - cone.coneLower).toFixed(0)} pts to lower
            </span>
          }
        />
      ) : (
        view.breaches.map((b) => (
          <Row
            key={`${b.direction}-${b.breachTime}`}
            label={`${b.direction.toUpperCase()} breach`}
            value={
              <span style={{ color: theme.caution }}>
                {formatTimeCT(b.breachTime)} CT · spot{' '}
                {b.spotAtBreach.toFixed(2)} ({fmtSigned(b.ptsPastBound)} pts
                past)
              </span>
            }
          />
        ))
      )}
    </div>
  );
}

function GammaSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Gamma Topology</SectionHeader>
      <Row
        label="+γ ceiling"
        value={
          view.gamma.ceiling ? (
            <RankedCell row={view.gamma.ceiling} />
          ) : (
            <span style={{ color: theme.textMuted }}>none ±100</span>
          )
        }
      />
      <Row
        label="+γ floor"
        value={
          view.gamma.floor ? (
            <RankedCell row={view.gamma.floor} />
          ) : (
            <span style={{ color: theme.textMuted }}>none ±100</span>
          )
        }
      />
      <Row
        label="−γ accel (top 3)"
        value={
          view.gamma.accelTop.length > 0 ? (
            <span className="flex flex-wrap justify-end gap-x-3">
              {view.gamma.accelTop.map((r) => (
                <RankedCell key={r.strike} row={r} />
              ))}
            </span>
          ) : (
            <span style={{ color: theme.textMuted }}>none</span>
          )
        }
      />
    </div>
  );
}

function CharmSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Charm Flow</SectionHeader>
      <Row
        label="Net tally ±50"
        value={
          <span style={{ color: colorForValue(view.charm.tallyNear50) }}>
            {fmtSigned(view.charm.tallyNear50)}
          </span>
        }
      />
      <Row
        label="Net tally ±100"
        value={
          <span style={{ color: colorForValue(view.charm.tallyWide100) }}>
            {fmtSigned(view.charm.tallyWide100)}
          </span>
        }
      />
      {view.charm.topByAbs.length > 0 && (
        <Row
          label="Top |charm|"
          value={
            <span className="flex flex-wrap justify-end gap-x-3">
              {view.charm.topByAbs.map((r) => (
                <RankedCell key={r.strike} row={r} />
              ))}
            </span>
          }
        />
      )}
      {view.charm.charmZeroStrike != null && (
        <Row
          label="Charm-zero strike"
          value={
            <span style={{ color: theme.text }}>
              {view.charm.charmZeroStrike}
            </span>
          }
        />
      )}
    </div>
  );
}

function VannaSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Vanna Pressure</SectionHeader>
      <Row
        label="Top |vanna|"
        value={
          <span className="flex flex-wrap justify-end gap-x-3">
            {view.vanna.topByAbs.map((r) => (
              <RankedCell key={r.strike} row={r} />
            ))}
          </span>
        }
      />
    </div>
  );
}

function SignFlipsSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Sign Flips Since Prior Slice</SectionHeader>
      {view.signFlips.map((f) => (
        <div
          key={f.strike}
          className="flex items-baseline justify-between font-mono text-[11px]"
        >
          <span style={{ color: theme.textSecondary }}>{f.strike}</span>
          <span>
            <span style={{ color: colorForValue(f.from) }}>
              {fmtSigned(f.from)}
            </span>
            <span style={{ color: theme.textMuted }}> → </span>
            <span style={{ color: colorForValue(f.to) }}>
              {fmtSigned(f.to)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export const PeriscopePanel = memo(PeriscopePanelInner);
