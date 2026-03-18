import type { Theme } from '../../themes';
import type { AnalysisMode, AnalysisResult } from './types';
import { MODE_LABELS } from './types';
import { tint } from '../../utils/ui-utils';
import BulletList from './BulletList';
import Collapsible from './Collapsible';

interface Props {
  readonly th: Theme;
  readonly analysis: AnalysisResult;
  readonly mode: AnalysisMode;
  readonly onReplaceImage: (index: number) => void;
  defaultCollapsed?: boolean;
}

export default function AnalysisResults({
  th,
  analysis,
  mode,
  onReplaceImage,
  defaultCollapsed = false,
}: Props) {
  const structureColor = (s: string) => {
    if (s === 'IRON CONDOR') return th.accent;
    if (s === 'PUT CREDIT SPREAD') return th.red;
    if (s === 'CALL CREDIT SPREAD') return th.green;
    return th.caution;
  };

  const confidenceColor = (c: string) => {
    if (c === 'HIGH') return th.green;
    if (c === 'MODERATE') return th.caution;
    return th.red;
  };

  const signalColor = (s: string) => {
    if (s === 'BEARISH' || s === 'CONTRADICTS' || s === 'UNFAVORABLE')
      return th.red;
    if (s === 'BULLISH' || s === 'CONFIRMS' || s === 'FAVORABLE')
      return th.green;
    if (s === 'NEUTRAL' || s === 'NOT PROVIDED') return th.textMuted;
    return th.caution;
  };

  return (
    <div className="grid gap-2.5">
      {/* TL;DR SUMMARY CARD (always visible) */}
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
              backgroundColor: tint(th.accent, '18'),
              color: th.accent,
            }}
          >
            {analysis.suggestedDelta}
            {'\u0394'}
          </span>
          {analysis.hedge && analysis.hedge.recommendation !== 'NO HEDGE' && (
            <span
              className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
              style={{
                backgroundColor: tint(th.caution, '18'),
                color: th.caution,
              }}
            >
              {analysis.hedge.recommendation}
            </span>
          )}
          <span
            className="text-muted rounded-full px-2 py-0.5 font-mono text-[10px]"
            style={{ backgroundColor: th.surfaceAlt }}
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
              <span className="font-semibold" style={{ color: th.accent }}>
                Entry 1:
              </span>
              <span className="text-secondary">
                {analysis.entryPlan.entry1.structure}{' '}
                {analysis.entryPlan.entry1.delta}
                {'\u0394'} at {analysis.entryPlan.entry1.sizePercent}% size
              </span>
              <span className="text-muted">{'\u2022'}</span>
              <span className="text-muted italic">
                {analysis.entryPlan.entry1.timing ??
                  analysis.entryPlan.entry1.condition}
              </span>
            </div>
          )}
          {analysis.strikeGuidance?.adjustments &&
            analysis.strikeGuidance.adjustments.length > 0 && (
              <div className="flex items-center gap-2 text-[10px]">
                <span className="font-semibold" style={{ color: th.accent }}>
                  Strike:
                </span>
                <span className="text-secondary">
                  {analysis.strikeGuidance.adjustments[0]}
                </span>
              </div>
            )}
          {analysis.managementRules?.profitTarget && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className="font-semibold" style={{ color: th.green }}>
                Target:
              </span>
              <span className="text-secondary">
                {analysis.managementRules.profitTarget}
              </span>
            </div>
          )}
          {analysis.hedge && analysis.hedge.recommendation !== 'NO HEDGE' && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className="font-semibold" style={{ color: th.caution }}>
                Hedge:
              </span>
              <span className="text-secondary">
                {analysis.hedge.description}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Per-Chart Confidence (always visible, compact) */}
      {analysis.chartConfidence && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(
            [
              ['marketTide', 'Market Tide'],
              ['spxNetFlow', 'SPX Flow'],
              ['spyNetFlow', 'SPY Flow'],
              ['qqqNetFlow', 'QQQ Flow'],
              ['periscope', 'Periscope'],
            ] as const
          ).map(([key, label]) => {
            const sig = analysis.chartConfidence?.[key];
            if (!sig || sig.signal === 'NOT PROVIDED') return null;
            return (
              <div
                key={key}
                className="bg-surface border-edge rounded-md border p-2.5"
              >
                <div className="text-muted mb-0.5 text-[10px] font-bold tracking-wider uppercase">
                  {label}
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-[13px] font-bold"
                    style={{ color: signalColor(sig.signal) }}
                  >
                    {sig.signal}
                  </span>
                  <span
                    className="text-[10px] font-semibold"
                    style={{ color: confidenceColor(sig.confidence) }}
                  >
                    {sig.confidence}
                  </span>
                </div>
                <div className="text-muted mt-1 text-[10px] leading-snug">
                  {sig.note}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* COLLAPSIBLE DETAIL SECTIONS */}

      {/* Observations */}
      <Collapsible title="Key Observations" color={th.textMuted}>
        <BulletList defaultColor={th.textMuted} items={analysis.observations} />
      </Collapsible>

      {/* Strike Guidance */}
      {analysis.strikeGuidance && (
        <Collapsible
          title="Strike Placement Guidance"
          color={th.accent}
          defaultOpen={!defaultCollapsed}
        >
          <div className="grid gap-1.5">
            {analysis.strikeGuidance.putStrikeNote && (
              <div className="text-[11px] leading-relaxed">
                <span className="text-danger font-semibold">Put: </span>
                <span className="text-secondary">
                  {analysis.strikeGuidance.putStrikeNote}
                </span>
              </div>
            )}
            {analysis.strikeGuidance.callStrikeNote && (
              <div className="text-[11px] leading-relaxed">
                <span className="text-success font-semibold">Call: </span>
                <span className="text-secondary">
                  {analysis.strikeGuidance.callStrikeNote}
                </span>
              </div>
            )}
            {analysis.strikeGuidance.straddleCone && (
              <div
                className="text-muted mt-1 rounded-md px-2 py-1 text-[10px]"
                style={{ backgroundColor: th.surfaceAlt }}
              >
                Straddle cone: {analysis.strikeGuidance.straddleCone.lower}{' '}
                {'\u2013'} {analysis.strikeGuidance.straddleCone.upper}
                {' \u2022 '}
                {analysis.strikeGuidance.straddleCone.priceRelation}
              </div>
            )}
            {analysis.strikeGuidance.adjustments &&
              analysis.strikeGuidance.adjustments.length > 0 && (
                <div className="mt-1">
                  <BulletList
                    defaultColor={th.textMuted}
                    items={analysis.strikeGuidance.adjustments}
                    icon={'\u2192'}
                    color={th.accent}
                  />
                </div>
              )}
          </div>
        </Collapsible>
      )}

      {/* Entry Plan */}
      {analysis.entryPlan && (
        <Collapsible
          title="Entry Plan"
          color={th.accent}
          defaultOpen={!defaultCollapsed}
        >
          <div className="grid gap-2">
            {[
              analysis.entryPlan.entry1,
              analysis.entryPlan.entry2,
              analysis.entryPlan.entry3,
            ].map((entry, i) => {
              if (!entry) return null;
              return (
                <div
                  key={i}
                  className="bg-surface-alt flex items-start gap-2.5 rounded-md p-2"
                >
                  <div
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold"
                    style={{
                      backgroundColor: tint(th.accent, '18'),
                      color: th.accent,
                    }}
                  >
                    {i + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className="text-[11px] font-semibold"
                        style={{ color: structureColor(entry.structure) }}
                      >
                        {entry.structure}
                      </span>
                      <span
                        className="font-mono text-[10px] font-bold"
                        style={{ color: th.accent }}
                      >
                        {entry.delta}
                        {'\u0394'}
                      </span>
                      <span className="text-muted text-[10px]">
                        {entry.sizePercent}% size
                      </span>
                    </div>
                    <div className="text-muted text-[10px]">
                      {entry.timing ?? entry.condition}
                    </div>
                    <div className="text-secondary mt-0.5 text-[10px] italic">
                      {entry.note}
                    </div>
                  </div>
                </div>
              );
            })}
            {analysis.entryPlan.maxTotalSize && (
              <div className="text-muted text-[10px]">
                Max size: {analysis.entryPlan.maxTotalSize}
              </div>
            )}
            {analysis.entryPlan.noEntryConditions &&
              analysis.entryPlan.noEntryConditions.length > 0 && (
                <div className="mt-1">
                  <div
                    className="mb-0.5 text-[10px] font-bold uppercase"
                    style={{ color: th.red }}
                  >
                    Do NOT add entries if:
                  </div>
                  <BulletList
                    defaultColor={th.textMuted}
                    items={analysis.entryPlan.noEntryConditions}
                    icon={'\u2718'}
                    color={th.red}
                  />
                </div>
              )}
          </div>
        </Collapsible>
      )}

      {/* Management Rules */}
      {analysis.managementRules && (
        <Collapsible title="Position Management Rules" color={th.caution}>
          <div className="grid gap-1.5">
            {analysis.managementRules.profitTarget && (
              <div className="text-[11px] leading-relaxed">
                <span className="font-semibold" style={{ color: th.green }}>
                  Profit target:{' '}
                </span>
                <span className="text-secondary">
                  {analysis.managementRules.profitTarget}
                </span>
              </div>
            )}
            {analysis.managementRules.stopConditions &&
              analysis.managementRules.stopConditions.length > 0 && (
                <div>
                  <span
                    className="text-[10px] font-semibold"
                    style={{ color: th.red }}
                  >
                    Stop conditions:
                  </span>
                  <BulletList
                    defaultColor={th.textMuted}
                    items={analysis.managementRules.stopConditions}
                    icon={'\u26D4'}
                    color={th.red}
                  />
                </div>
              )}
            {analysis.managementRules.timeRules && (
              <div className="text-[11px] leading-relaxed">
                <span className="font-semibold" style={{ color: th.caution }}>
                  Time rule:{' '}
                </span>
                <span className="text-secondary">
                  {analysis.managementRules.timeRules}
                </span>
              </div>
            )}
            {analysis.managementRules.flowReversalSignal && (
              <div className="text-[11px] leading-relaxed">
                <span className="font-semibold" style={{ color: th.caution }}>
                  Flow reversal:{' '}
                </span>
                <span className="text-secondary">
                  {analysis.managementRules.flowReversalSignal}
                </span>
              </div>
            )}
          </div>
        </Collapsible>
      )}

      {/* Risk Factors */}
      {analysis.risks.length > 0 && (
        <Collapsible title="Risk Factors" color={th.red}>
          <BulletList
            defaultColor={th.textMuted}
            items={analysis.risks}
            icon={'\u26A0'}
            color={th.red}
          />
        </Collapsible>
      )}

      {/* Hedge */}
      {analysis.hedge && (
        <Collapsible
          title={`Hedge: ${analysis.hedge.recommendation}`}
          color={
            analysis.hedge.recommendation === 'NO HEDGE'
              ? th.green
              : analysis.hedge.recommendation === 'SKIP'
                ? th.red
                : th.caution
          }
        >
          <div>
            {analysis.hedge.estimatedCost &&
              analysis.hedge.recommendation !== 'NO HEDGE' &&
              analysis.hedge.recommendation !== 'SKIP' && (
                <span
                  className="text-muted mb-1.5 inline-block rounded-full px-1.5 py-0.5 font-mono text-[8px]"
                  style={{ backgroundColor: th.surfaceAlt }}
                >
                  {analysis.hedge.estimatedCost}
                </span>
              )}
            <div className="text-secondary text-[11px] leading-relaxed">
              {analysis.hedge.description}
            </div>
            {analysis.hedge.rationale && (
              <div className="text-muted mt-1 text-[10px] leading-relaxed italic">
                {analysis.hedge.rationale}
              </div>
            )}
          </div>
        </Collapsible>
      )}

      {/* Periscope Analysis */}
      {analysis.periscopeNotes && (
        <Collapsible title="Periscope Analysis" color={th.textMuted}>
          <div className="text-secondary text-[11px] leading-relaxed">
            {analysis.periscopeNotes}
          </div>
        </Collapsible>
      )}

      {/* End-of-Day Review (always visible when present) */}
      {analysis.review && (
        <div
          className="rounded-[10px] p-3.5"
          style={{
            backgroundColor: analysis.review.wasCorrect
              ? tint(th.green, '08')
              : tint(th.red, '08'),
            border: `1.5px solid ${tint(analysis.review.wasCorrect ? th.green : th.red, '20')}`,
          }}
        >
          <div className="mb-2 flex items-center gap-2">
            <span
              className="font-sans text-[11px] font-bold"
              style={{
                color: analysis.review.wasCorrect ? th.green : th.red,
              }}
            >
              {analysis.review.wasCorrect
                ? '\u2713 Recommendation was correct'
                : '\u2717 Recommendation was incorrect'}
            </span>
          </div>
          <div className="grid gap-2">
            <div className="text-[11px] leading-relaxed">
              <span className="font-semibold" style={{ color: th.green }}>
                What worked:{' '}
              </span>
              <span className="text-secondary">
                {analysis.review.whatWorked}
              </span>
            </div>
            <div className="text-[11px] leading-relaxed">
              <span className="font-semibold" style={{ color: th.caution }}>
                What was missed:{' '}
              </span>
              <span className="text-secondary">
                {analysis.review.whatMissed}
              </span>
            </div>
            <div className="text-[11px] leading-relaxed">
              <span className="font-semibold" style={{ color: th.accent }}>
                Optimal trade:{' '}
              </span>
              <span className="text-secondary">
                {analysis.review.optimalTrade}
              </span>
            </div>
            {analysis.review.lessonsLearned.length > 0 && (
              <div>
                <div
                  className="mb-0.5 text-[10px] font-bold tracking-wider uppercase"
                  style={{ color: th.accent }}
                >
                  Lessons for next time
                </div>
                <BulletList
                  defaultColor={th.textMuted}
                  items={analysis.review.lessonsLearned}
                  icon={'\u{1F4A1}'}
                  color={th.accent}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Structure Rationale */}
      <Collapsible title="Structure Rationale" color={th.textMuted}>
        <div className="text-secondary text-[11px] leading-relaxed italic">
          {analysis.structureRationale}
        </div>
      </Collapsible>

      {/* Image Issues (always visible - actionable) */}
      {analysis.imageIssues && analysis.imageIssues.length > 0 && (
        <div
          className="rounded-lg p-3"
          style={{
            backgroundColor: tint(th.caution, '08'),
            border: '1px solid ' + tint(th.caution, '20'),
          }}
        >
          <div
            className="mb-2 font-sans text-[10px] font-bold tracking-wider uppercase"
            style={{ color: th.caution }}
          >
            Image Issues {'\u2014'} {analysis.imageIssues.length} image
            {analysis.imageIssues.length > 1 ? 's' : ''} need
            {analysis.imageIssues.length === 1 ? 's' : ''} improvement
          </div>
          <div className="grid gap-2">
            {analysis.imageIssues.map((issue, i) => (
              <div
                key={i}
                className="bg-surface border-edge flex items-start gap-2.5 rounded-md border p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="mb-0.5 font-sans text-[11px] font-semibold"
                    style={{ color: th.caution }}
                  >
                    Image {issue.imageIndex}: {issue.label}
                  </div>
                  <div className="text-secondary text-[10px] leading-relaxed">
                    {issue.issue}
                  </div>
                  <div className="text-muted mt-0.5 text-[10px] italic">
                    {'\u2192'} {issue.suggestion}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onReplaceImage(issue.imageIndex)}
                  className="shrink-0 cursor-pointer rounded-md px-2.5 py-1.5 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
                  style={{
                    backgroundColor: tint(th.caution, '18'),
                    color: th.caution,
                    border: '1px solid ' + tint(th.caution, '30'),
                  }}
                >
                  Replace
                </button>
              </div>
            ))}
          </div>
          <div className="text-muted mt-2 text-[10px]">
            Replace the flagged image
            {analysis.imageIssues.length > 1 ? 's' : ''}, then click{' '}
            <strong>Analyze</strong> again.
          </div>
        </div>
      )}
    </div>
  );
}
