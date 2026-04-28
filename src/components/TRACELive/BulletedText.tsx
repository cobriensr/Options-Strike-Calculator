/**
 * BulletedText — render a string with "- " prefixed lines as a styled
 * bullet list. Lines without the prefix render as paragraph headers
 * (used for "STEP 1 — GAMMA" header lines that group bullets below).
 *
 * Tolerates legacy paragraph-form text (no bullet markers) by rendering
 * the whole input as a single paragraph — so older trace_live_analyses
 * rows produced before the prompt was switched to bulleted output still
 * display readably without re-running the analysis.
 *
 * Used by TRACELiveSynthesisPanel (reasoning summary, per step) and
 * TRACELiveTabPanel (per-chart notes).
 */

import { Fragment, type ReactNode } from 'react';

interface Props {
  readonly text: string;
}

function BulletedText({ text }: Readonly<Props>) {
  const lines = text.split('\n');

  // Legacy paragraph-form text — no "- " bullet markers anywhere — gets
  // rendered whole with newlines preserved. Without this guard, the
  // line-by-line loop below would route every non-bullet line into the
  // header <p> branch, fragmenting paragraphs and stripping their
  // intra-paragraph whitespace. Matches the file-level contract.
  const hasBulletMarker = lines.some((l) => l.trim().startsWith('- '));
  if (!hasBulletMarker) {
    return (
      <p className="text-secondary text-[11px] leading-relaxed whitespace-pre-wrap">
        {text}
      </p>
    );
  }

  const elements: ReactNode[] = [];
  let bulletGroup: string[] = [];
  let groupKey = 0;

  const flushBullets = () => {
    if (bulletGroup.length === 0) return;
    elements.push(
      <ul
        key={`ul-${groupKey++}`}
        className="text-secondary ml-4 list-disc space-y-1 text-[11px] leading-relaxed"
      >
        {bulletGroup.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>,
    );
    bulletGroup = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('- ')) {
      bulletGroup.push(line.slice(2));
      continue;
    }
    if (line === '') {
      flushBullets();
      continue;
    }
    // Header / non-bullet line — flush any pending bullets, then render
    // as a small bold paragraph above the next group.
    flushBullets();
    elements.push(
      <p
        key={`p-${groupKey++}`}
        className="text-secondary mt-2 text-[11px] font-semibold tracking-wide first:mt-0"
      >
        {line}
      </p>,
    );
  }
  flushBullets();

  return (
    <>
      {elements.map((el, i) => (
        <Fragment key={i}>{el}</Fragment>
      ))}
    </>
  );
}

export default BulletedText;
