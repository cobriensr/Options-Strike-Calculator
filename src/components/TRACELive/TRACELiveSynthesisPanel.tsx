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

      {/* Reasoning summary — debug-friendly, collapsed by default */}
      {detail.analysis?.reasoningSummary && (
        <Collapsible title="Reasoning Summary" color={theme.textMuted}>
          <div className="text-secondary text-[11px] leading-relaxed whitespace-pre-wrap">
            {detail.analysis.reasoningSummary}
          </div>
        </Collapsible>
      )}
    </div>
  );
}

export default memo(TRACELiveSynthesisPanel);
