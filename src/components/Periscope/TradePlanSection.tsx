/**
 * Deterministic client-derived TradePlan section of the Periscope panel.
 *
 * As of the Claude auto-playbook retirement (2026-05-26 — see
 * cf70bcba and the periscope-auto-playbook removal), this is the
 * panel's primary trade-plan surface. The prose `PlaybookSection`
 * and `usePeriscopePlaybook` hook have been removed.
 *
 * Extracted from PeriscopePanel.tsx during the Phase 3A decomposition
 * (2026-05-19). DirectionalRow is kept private to this file because no
 * other section uses it.
 */

import { theme } from '../../themes';
import type { TradePlan } from '../../utils/periscope-trade-plan';
import {
  fmtLevel,
  regimeColor,
  verdictColor,
} from '../../utils/periscope-formatting';

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
          className="rounded px-1.5 py-0.5 text-[10px] tracking-wider uppercase"
          style={{
            color,
            backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
          }}
        >
          {plan.verdict}
        </span>
        {plan.verdict !== 'avoid' && (
          <span className="text-[10px]" style={{ color: theme.textSecondary }}>
            trigger {fmtLevel(plan.trigger)} · stop {fmtLevel(plan.stop)} ·
            target {fmtLevel(plan.target)}
          </span>
        )}
      </div>
      <span className="leading-snug" style={{ color: theme.textMuted }}>
        {plan.reason}
      </span>
    </div>
  );
}

export function TradePlanSection({ plan }: { plan: TradePlan }) {
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
            className="rounded px-1.5 py-0.5 tracking-wider uppercase"
            style={{
              color: regimeColor(plan.regime),
              backgroundColor: `color-mix(in srgb, ${regimeColor(plan.regime)} 15%, transparent)`,
            }}
          >
            {plan.regime}
          </span>
          <span
            className="rounded px-1.5 py-0.5 tracking-wider uppercase"
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
          <span className="font-bold" style={{ color: theme.textTertiary }}>
            WAIT
          </span>
          <span style={{ color: theme.textMuted }}>{plan.waitZone}</span>
        </div>
      )}
    </div>
  );
}
