import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { AnalysisMode, AnalysisResult } from './types';
import { MODE_LABELS } from './types';
import { structureColor, confidenceColor } from './analysis-helpers';

interface Props {
  readonly analysis: AnalysisResult;
  readonly mode: AnalysisMode;
}

export default function SummaryCard({ analysis, mode }: Props) {
  return (
    <div
      className="rounded-[10px] p-3.5"
      style={{
        backgroundColor: tint(structureColor(analysis.structure), '0C'),
        border: `1.5px solid ${tint(structureColor(analysis.structure), '30')}`,
      }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span
          className="font-sans text-[15px] font-bold"
          style={{ color: structureColor(analysis.structure) }}
        >
          {analysis.structure}
        </span>
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
          style={{
            backgroundColor: tint(confidenceColor(analysis.confidence), '18'),
            color: confidenceColor(analysis.confidence),
          }}
        >
          {analysis.confidence}
        </span>
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
          style={{
            backgroundColor: tint(theme.accent, '18'),
            color: theme.accent,
          }}
        >
          {analysis.suggestedDelta}
          {'\u0394'}
        </span>
        {analysis.hedge && analysis.hedge.recommendation !== 'NO HEDGE' && (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            style={{
              backgroundColor: tint(theme.caution, '18'),
              color: theme.caution,
            }}
          >
            {analysis.hedge.recommendation}
          </span>
        )}
        <span
          className="text-muted rounded-full px-2 py-0.5 font-mono text-[10px]"
          style={{ backgroundColor: theme.surfaceAlt }}
        >
          {MODE_LABELS[analysis.mode ?? mode].label}
        </span>
      </div>

      {/* One-line reasoning */}
      <div className="text-secondary mb-2 text-[11px] leading-relaxed">
        {analysis.reasoning}
      </div>

      {/* Quick-glance: Entry 1 + Hedge + Profit target */}
      <div
        className="grid gap-1 border-t pt-2"
        style={{
          borderColor: tint(structureColor(analysis.structure), '20'),
        }}
      >
        {analysis.entryPlan?.entry1 && (
          <div className="flex items-center gap-2 text-[10px]">
            <span className="font-semibold" style={{ color: theme.accent }}>
              Entry 1:
            </span>
            <span className="text-secondary">
              {analysis.entryPlan.entry1.structure}{' '}
              {analysis.entryPlan.entry1.delta}
              {'\u0394'} at {analysis.entryPlan.entry1.sizePercent}% size
            </span>
            <span className="text-muted">{'\u2022'}</span>
            <span className="text-muted italic">
              {analysis.entryPlan.entry1.timing ||
                analysis.entryPlan.entry1.condition}
            </span>
          </div>
        )}
        {analysis.strikeGuidance?.adjustments &&
          analysis.strikeGuidance.adjustments.length > 0 && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className="font-semibold" style={{ color: theme.accent }}>
                Strike:
              </span>
              <span className="text-secondary">
                {analysis.strikeGuidance.adjustments[0]}
              </span>
            </div>
          )}
        {analysis.managementRules?.profitTarget && (
          <div className="flex items-center gap-2 text-[10px]">
            <span className="font-semibold" style={{ color: theme.green }}>
              Target:
            </span>
            <span className="text-secondary">
              {analysis.managementRules.profitTarget}
            </span>
          </div>
        )}
        {analysis.hedge && analysis.hedge.recommendation !== 'NO HEDGE' && (
          <div className="flex items-center gap-2 text-[10px]">
            <span className="font-semibold" style={{ color: theme.caution }}>
              Hedge:
            </span>
            <span className="text-secondary">{analysis.hedge.description}</span>
          </div>
        )}
      </div>
    </div>
  );
}
