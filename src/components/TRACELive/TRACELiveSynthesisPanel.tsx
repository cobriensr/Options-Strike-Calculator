/**
 * TRACELiveSynthesisPanel — cross-chart synthesis below the active tab.
 *
 * Renders the trade recommendation, cross-chart agreement label, warnings
 * list, and the optional reasoning summary (collapsed by default for
 * audit-trail consumption). Lives BELOW the tabs, not inside one of them,
 * because the synthesis is the model's verdict after reading all 3 charts
 * — burying it inside (say) the gamma tab would imply it's gamma-specific
 * and lose it whenever the user clicks Charm or Delta.
 */

import { memo } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import Collapsible from '../ChartAnalysis/Collapsible';
import BulletList from '../ChartAnalysis/BulletList';
import BulletedText from './BulletedText';
import type { TraceLiveDetail } from './types';

interface Props {
  readonly detail: TraceLiveDetail | null;
}

function tradeTypeLabel(type: string): string {
  return type.replace(/_/g, ' ');
}

function sizeColor(size: string): string {
  switch (size) {
    case 'full':
      return theme.green;
    case 'three_quarter':
      return theme.green;
    case 'half':
      return theme.accent;
    case 'quarter':
      return theme.caution;
    case 'none':
      return theme.red;
    default:
      return theme.textMuted;
  }
}

function agreementLabel(a: string): string {
  return a.replace(/_/g, ' ');
}

/**
 * Split the model's reasoningSummary on "STEP 1", "STEP 2", "STEP 3"
 * markers so we can render each step as its own collapsible section.
 * The tail after STEP 3 (OVERRIDE HIERARCHY / CONFIDENCE / SIZE / TRADE)
 * stays attached to step 3 — it's the synthesis decision that follows
 * from the delta read.
 *
 * Returns null when the markers aren't all present (older rows or
 * model variations) so the caller can fall back to single-block render.
 */
function parseReasoningSteps(
  summary: string,
): { step1: string; step2: string; step3: string } | null {
  const i1 = summary.indexOf('STEP 1');
  const i2 = summary.indexOf('STEP 2');
  const i3 = summary.indexOf('STEP 3');
  if (i1 === -1 || i2 === -1 || i3 === -1 || !(i1 < i2 && i2 < i3)) {
    return null;
  }
  return {
    step1: summary.slice(i1, i2).trim(),
    step2: summary.slice(i2, i3).trim(),
    step3: summary.slice(i3).trim(),
  };
}

function TRACELiveSynthesisPanel({ detail }: Readonly<Props>) {
  const synth = detail?.analysis?.synthesis;
  if (!synth) return null;

  const { trade, crossChartAgreement, warnings } = synth;
  const sizeAccent = sizeColor(trade.size);

  return (
    <div className="mt-3 grid gap-2.5">
      {/* Trade recommendation — default open */}
      <Collapsible title="Trade Recommendation" color={sizeAccent} defaultOpen>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase"
            style={{
              backgroundColor: tint(sizeAccent, '18'),
              color: sizeAccent,
            }}
          >
            {tradeTypeLabel(trade.type)}
          </span>
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{
              backgroundColor: tint(sizeAccent, '18'),
              color: sizeAccent,
            }}
          >
            size {trade.size.replace('_', ' ')}
          </span>
          {trade.centerStrike != null && (
            <span className="text-secondary font-mono">
              center{' '}
              <span className="text-tertiary font-semibold">
                {trade.centerStrike}
              </span>
            </span>
          )}
          {trade.wingWidth != null && (
            <span className="text-secondary font-mono">
              wing{' '}
              <span className="text-tertiary font-semibold">
                ±{trade.wingWidth}
              </span>
            </span>
          )}
        </div>
      </Collapsible>

      {/* Cross-chart agreement */}
      <Collapsible title="Cross-Chart Agreement" color={theme.accent}>
        <div className="text-secondary font-mono text-[11px] uppercase">
          {agreementLabel(crossChartAgreement)}
        </div>
      </Collapsible>

      {/* Warnings — only when present */}
      {warnings.length > 0 && (
        <Collapsible title="Warnings" color={theme.red} defaultOpen>
          <BulletList
            defaultColor={theme.textMuted}
            items={warnings}
            icon={'⚠'}
            color={theme.red}
          />
        </Collapsible>
      )}

      {/* Reasoning summary — split per step. Falls back to single block
          when the STEP markers aren't present (older rows). Each step is
          its own collapsible so the user can drill into one chart's
          read without skimming a wall of text. */}
      {detail.analysis?.reasoningSummary &&
        (() => {
          const summary = detail.analysis.reasoningSummary;
          const parsed = parseReasoningSteps(summary);
          if (!parsed) {
            return (
              <Collapsible title="Reasoning Summary" color={theme.textMuted}>
                <BulletedText text={summary} />
              </Collapsible>
            );
          }
          return (
            <>
              <Collapsible title="Step 1 — Gamma" color={theme.textMuted}>
                <BulletedText text={parsed.step1} />
              </Collapsible>
              <Collapsible title="Step 2 — Charm" color={theme.textMuted}>
                <BulletedText text={parsed.step2} />
              </Collapsible>
              <Collapsible
                title="Step 3 — Delta + Synthesis"
                color={theme.textMuted}
              >
                <BulletedText text={parsed.step3} />
              </Collapsible>
            </>
          );
        })()}
    </div>
  );
}

export default memo(TRACELiveSynthesisPanel);
