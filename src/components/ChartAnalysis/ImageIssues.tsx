import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import type { AnalysisResult } from './types';

interface Props {
  readonly imageIssues: NonNullable<AnalysisResult['imageIssues']>;
  readonly onReplaceImage: (index: number) => void;
}

export default function ImageIssues({ imageIssues, onReplaceImage }: Props) {
  return (
    <div
      className="rounded-lg p-3"
      style={{
        backgroundColor: tint(theme.caution, '08'),
        border: '1px solid ' + tint(theme.caution, '20'),
      }}
    >
      <div
        className="mb-2 font-sans text-[10px] font-bold tracking-wider uppercase"
        style={{ color: theme.caution }}
      >
        Image Issues {'\u2014'} {imageIssues.length} image
        {imageIssues.length > 1 ? 's' : ''} need
        {imageIssues.length === 1 ? 's' : ''} improvement
      </div>
      <div className="grid gap-2">
        {imageIssues.map((issue) => (
          <div
            key={`img-${issue.imageIndex}-${issue.label}`}
            className="bg-surface border-edge flex items-start gap-2.5 rounded-md border p-2.5"
          >
            <div className="min-w-0 flex-1">
              <div
                className="mb-0.5 font-sans text-[11px] font-semibold"
                style={{ color: theme.caution }}
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
                backgroundColor: tint(theme.caution, '18'),
                color: theme.caution,
                border: '1px solid ' + tint(theme.caution, '30'),
              }}
            >
              Replace
            </button>
          </div>
        ))}
      </div>
      <div className="text-muted mt-2 text-[10px]">
        Replace the flagged image
        {imageIssues.length > 1 ? 's' : ''}, then click <strong>Analyze</strong>{' '}
        again.
      </div>
    </div>
  );
}
