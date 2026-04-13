import { theme } from '../../themes';
import type { AnalysisMode, AnalysisResult } from './types';
import BulletList from './BulletList';
import Collapsible from './Collapsible';
import SummaryCard from './SummaryCard';
import ChartConfidenceGrid from './ChartConfidenceGrid';
import EntryPlan from './EntryPlan';
import DirectionalOpportunity from './DirectionalOpportunity';
import ManagementRules from './ManagementRules';
import EndOfDayReview from './EndOfDayReview';
import ImageIssues from './ImageIssues';

interface Props {
  readonly analysis: AnalysisResult;
  readonly mode: AnalysisMode;
  readonly onReplaceImage: (index: number) => void;
  defaultCollapsed?: boolean;
}

export default function AnalysisResults({
  analysis,
  mode,
  onReplaceImage,
  defaultCollapsed = false,
}: Readonly<Props>) {
  return (
    <div className="grid gap-2.5">
      {/* TL;DR SUMMARY CARD (always visible) */}
      <SummaryCard analysis={analysis} mode={mode} />

      {/* Per-Chart Confidence (always visible, compact) */}
      {analysis.chartConfidence && (
        <ChartConfidenceGrid chartConfidence={analysis.chartConfidence} />
      )}

      {/* COLLAPSIBLE DETAIL SECTIONS */}

      {/* Observations */}
      <Collapsible title="Key Observations" color={theme.textMuted}>
        <BulletList
          defaultColor={theme.textMuted}
          items={analysis.observations}
        />
      </Collapsible>

      {/* Strike Guidance */}
      {analysis.strikeGuidance && (
        <Collapsible
          title="Strike Placement Guidance"
          color={theme.accent}
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
                style={{ backgroundColor: theme.surfaceAlt }}
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
                    defaultColor={theme.textMuted}
                    items={analysis.strikeGuidance.adjustments}
                    icon={'\u2192'}
                    color={theme.accent}
                  />
                </div>
              )}
          </div>
        </Collapsible>
      )}

      {/* Entry Plan */}
      {analysis.entryPlan && (
        <EntryPlan
          entryPlan={analysis.entryPlan}
          defaultCollapsed={defaultCollapsed}
        />
      )}

      {/* Directional Opportunity (midday only, when present) */}
      {analysis.directionalOpportunity && (
        <DirectionalOpportunity
          directionalOpportunity={analysis.directionalOpportunity}
        />
      )}

      {/* Management Rules */}
      {analysis.managementRules && (
        <ManagementRules managementRules={analysis.managementRules} />
      )}

      {/* Risk Factors */}
      {analysis.risks.length > 0 && (
        <Collapsible title="Risk Factors" color={theme.red}>
          <BulletList
            defaultColor={theme.textMuted}
            items={analysis.risks}
            icon={'\u26A0'}
            color={theme.red}
          />
        </Collapsible>
      )}

      {/* Hedge */}
      {analysis.hedge && (
        <Collapsible
          title={`Hedge: ${analysis.hedge.recommendation}`}
          color={
            analysis.hedge.recommendation === 'NO HEDGE'
              ? theme.green
              : analysis.hedge.recommendation === 'SKIP'
                ? theme.red
                : theme.caution
          }
        >
          <div>
            {analysis.hedge.estimatedCost &&
              analysis.hedge.recommendation !== 'NO HEDGE' &&
              analysis.hedge.recommendation !== 'SKIP' && (
                <span
                  className="text-muted mb-1.5 inline-block rounded-full px-1.5 py-0.5 font-mono text-[8px]"
                  style={{ backgroundColor: theme.surfaceAlt }}
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
        <Collapsible title="Periscope Analysis" color={theme.textMuted}>
          <div className="text-secondary text-[11px] leading-relaxed">
            {analysis.periscopeNotes}
          </div>
        </Collapsible>
      )}

      {/* Pressure Analysis */}
      {analysis.pressureAnalysis && (
        <Collapsible title="Pressure Analysis" color={theme.textMuted}>
          <div className="text-secondary text-[11px] leading-relaxed">
            {analysis.pressureAnalysis}
          </div>
        </Collapsible>
      )}

      {/* End-of-Day Review (always visible when present) */}
      {analysis.review && <EndOfDayReview review={analysis.review} />}

      {/* Structure Rationale */}
      <Collapsible title="Structure Rationale" color={theme.textMuted}>
        <div className="text-secondary text-[11px] leading-relaxed italic">
          {analysis.structureRationale}
        </div>
      </Collapsible>

      {/* Image Issues (always visible - actionable) */}
      {analysis.imageIssues && analysis.imageIssues.length > 0 && (
        <ImageIssues
          imageIssues={analysis.imageIssues}
          onReplaceImage={onReplaceImage}
        />
      )}
    </div>
  );
}
