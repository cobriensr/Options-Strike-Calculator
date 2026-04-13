/**
 * PlotAnalysis — Renders the 2-section analysis text for the active plot.
 *
 * Section 1: What does the data mean?
 * Section 2: How should I apply this to my trading?
 *
 * Shows "Analysis pending" if analysis is null.
 */

import { memo } from 'react';
import type { PlotAnalysis as PlotAnalysisData } from '../../hooks/useMLInsights';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';

interface Props {
  readonly analysis: PlotAnalysisData | null;
  readonly plotName: string;
}

const SECTIONS: Array<{
  key: keyof PlotAnalysisData;
  label: string;
  color: string;
}> = [
  {
    key: 'what_it_means',
    label: 'What the Data Means',
    color: theme.accent,
  },
  {
    key: 'how_to_apply',
    label: 'How to Apply',
    color: theme.caution,
  },
  {
    key: 'watch_out_for',
    label: 'Watch Out For',
    color: theme.red,
  },
];

const PlotAnalysis = memo(function PlotAnalysis({ analysis, plotName }: Props) {
  if (!analysis) {
    return (
      <div
        className="border-edge rounded-lg border px-4 py-6 text-center"
        style={{ backgroundColor: tint(theme.surfaceAlt, '80') }}
      >
        <div className="text-muted font-sans text-[11px] italic">
          Analysis pending for {plotName.replaceAll('_', ' ')}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {SECTIONS.map(({ key, label, color }) => (
        <div
          key={key}
          className="border-edge overflow-hidden rounded-lg border"
        >
          <div
            className="px-3 py-1.5"
            style={{ backgroundColor: tint(color, '06') }}
          >
            <span
              className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
              style={{ color }}
            >
              {label}
            </span>
          </div>
          <div className="px-3 pt-1.5 pb-3">
            <p className="text-secondary font-serif text-[11px] leading-relaxed whitespace-pre-wrap">
              {analysis[key]}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
});

export default PlotAnalysis;
