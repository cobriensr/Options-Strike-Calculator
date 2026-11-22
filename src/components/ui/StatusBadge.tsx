import { memo } from 'react';
import { SrHint } from './SrHint.js';

/**
 * Status badge with tinted background — used in the header for LIVE,
 * CLOSED, BACKTEST, etc.
 *
 * `title` is the mouse-only hover text. `srHint` is the same explanation
 * as hidden text after the label, for a screen reader (see SrHint); it is
 * opt-in, so a caller that only wants a hover keeps its markup.
 *
 * `shortLabel` is what a phone shows (below sm), without the dot and with
 * tighter padding. `label` stays the text screen readers get at every
 * width (visually hidden on a phone), and the short form is aria-hidden.
 * The badge is then `relative`, so the hidden label is positioned and
 * clipped with it inside a scrolling row instead of widening the page.
 * The same goes for `srHint`: its sr-only span is absolutely positioned
 * too, so a badge with a hint is `relative` whether or not it has a
 * `shortLabel`.
 */
export const StatusBadge = memo(function StatusBadge({
  label,
  shortLabel,
  color,
  dot,
  title,
  srHint,
}: {
  label: string;
  shortLabel?: string;
  color: string;
  dot?: boolean;
  title?: string;
  srHint?: string;
}) {
  let cls = 'rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold';
  if (shortLabel != null) cls += ' relative max-sm:px-2';
  else if (srHint != null) cls += ' relative';
  const style = {
    backgroundColor: `color-mix(in srgb, ${color} 9%, transparent)`,
    color,
  };
  const full = (
    <>
      {dot && '● '}
      {label}
    </>
  );

  return (
    <span className={cls} style={style} title={title}>
      {shortLabel == null ? (
        full
      ) : (
        <>
          <span aria-hidden="true" className="sm:hidden">
            {shortLabel}
          </span>
          <span className="max-sm:sr-only">{full}</span>
        </>
      )}
      {srHint != null && <SrHint>{srHint}</SrHint>}
    </span>
  );
});
