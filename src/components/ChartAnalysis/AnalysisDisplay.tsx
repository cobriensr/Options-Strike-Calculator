/**
 * AnalysisDisplay — Renders analysis results and raw response fallback.
 */

import type { AnalysisMode, AnalysisResult } from './types';
import AnalysisResultsView from './AnalysisResults';

interface Props {
  readonly analysis: AnalysisResult | null;
  readonly rawResponse: string | null;
  readonly mode: AnalysisMode;
  readonly onReplaceImage: (index: number) => void;
}

export default function AnalysisDisplay({
  analysis,
  rawResponse,
  mode,
  onReplaceImage,
}: Props) {
  return (
    <>
      {/* Results */}
      {analysis && (
        <AnalysisResultsView
          analysis={analysis}
          mode={mode}
          onReplaceImage={onReplaceImage}
        />
      )}

      {/* Raw response fallback */}
      {!analysis && rawResponse && (
        <div className="bg-surface-alt border-edge rounded-lg border p-3">
          <div className="text-muted mb-1 font-sans text-[10px] font-bold tracking-wider uppercase">
            Raw Analysis
          </div>
          <pre className="text-secondary max-h-48 overflow-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
            {rawResponse}
          </pre>
        </div>
      )}
    </>
  );
}
