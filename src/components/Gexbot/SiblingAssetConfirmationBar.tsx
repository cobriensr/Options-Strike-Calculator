/**
 * SiblingAssetConfirmationBar — inline pill row next to existing
 * TakeItScore badges on each Lottery + Silent Boom alert.
 *
 * For an alert on `{ticker, side}`, queries `/api/gexbot?view=
 * sibling-confirm&ticker=...&side=...` and renders one pill per
 * sibling ticker showing whether the broader-market signal confirms
 * or contradicts the alert's direction.
 *
 * Sibling groups are defined server-side in `api/_lib/gexbot-queries.ts`
 * (`SIBLING_GROUPS`): broad/vol/bonds/metals/energy. Single-stock
 * alerts default to broad-market siblings.
 *
 * Verdict heuristic (v0):
 *   - call alerts: sibling zcvr > 1 OR delta_risk_reversal > 0 → confirm
 *   - put alerts:  sibling zcvr < 1 OR delta_risk_reversal < 0 → confirm
 *   - else: neutral
 *
 * The bar deliberately renders nothing while loading or on empty data
 * — it's an inline augmentation, not a primary signal, so an absent
 * bar reads as "no information yet" rather than a broken UI.
 *
 * Spec: docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 */

import { memo } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';

interface SiblingAssetConfirmationBarProps {
  ticker: string;
  side: 'call' | 'put';
  marketOpen: boolean;
}

function verdictGlyph(verdict: 'confirm' | 'contradict' | 'neutral'): string {
  if (verdict === 'confirm') return '✓';
  if (verdict === 'contradict') return '✗';
  return '·';
}

function verdictClass(verdict: 'confirm' | 'contradict' | 'neutral'): string {
  if (verdict === 'confirm') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  }
  if (verdict === 'contradict') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
  }
  return 'border-white/10 bg-white/[0.04] text-tertiary';
}

function SiblingAssetConfirmationBarInner({
  ticker,
  side,
  marketOpen,
}: SiblingAssetConfirmationBarProps) {
  const { rows, loading, error } = useGexbotData(
    { view: 'sibling-confirm', ticker, side },
    marketOpen,
  );

  // Render nothing while loading, on error, or with no siblings — the
  // bar is an inline augmentation; absence reads as "no data" not
  // "broken". Errors surface via Sentry on the API side; we don't
  // pollute the row UI.
  if (loading || error || rows.length === 0) return null;

  return (
    <span
      role="group"
      aria-label={`Sibling-asset confirmation for ${ticker} ${side}`}
      data-testid={`sibling-bar-${ticker}-${side}`}
      className="inline-flex items-center gap-1"
    >
      <span className="text-tertiary mr-1 text-[9px] uppercase tracking-wide">
        siblings:
      </span>
      {rows.map((row) => (
        <span
          key={row.ticker}
          aria-label={`${row.ticker} ${row.verdict}`}
          data-testid={`sibling-pill-${ticker}-${row.ticker}`}
          className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] tabular-nums ${verdictClass(row.verdict)}`}
          title={[
            `${row.ticker} ${row.verdict}`,
            row.zcvr != null ? `zcvr=${row.zcvr.toFixed(2)}` : null,
            row.deltaRiskReversal != null
              ? `RR=${row.deltaRiskReversal.toFixed(3)}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <span className="font-semibold">{row.ticker}</span>
          <span aria-hidden>{verdictGlyph(row.verdict)}</span>
        </span>
      ))}
    </span>
  );
}

export const SiblingAssetConfirmationBar = memo(SiblingAssetConfirmationBarInner);
