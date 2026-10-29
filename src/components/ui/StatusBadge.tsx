import { memo } from 'react';

/**
 * Status badge with tinted background — used in the header for LIVE,
 * CLOSED, BACKTEST, etc.
 *
 * `shortLabel` is what a phone shows (below sm), without the dot and with
 * tighter padding. `label` stays the text screen readers get at every
 * width (visually hidden on a phone), and the short form is aria-hidden.
 * The badge is then `relative`, so the hidden label is positioned and
 * clipped with it inside a scrolling row instead of widening the page.
 * A link badge (`href`) can't take a `shortLabel`: a link's name is its
 * text, and the aria-hidden short form would leave what it shows out of
 * that name (WCAG 2.5.3, label in name).
 */
type StatusBadgeProps = {
  label: string;
  color: string;
  dot?: boolean;
  title?: string;
} & (
  | { href: string; shortLabel?: never }
  | { href?: undefined; shortLabel?: string }
);

export const StatusBadge = memo(function StatusBadge({
  label,
  shortLabel,
  color,
  dot,
  title,
  href,
}: StatusBadgeProps) {
  const cls =
    'rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold' +
    (shortLabel == null ? '' : ' relative max-sm:px-2');
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
  const content =
    shortLabel == null ? (
      full
    ) : (
      <>
        <span aria-hidden="true" className="sm:hidden">
          {shortLabel}
        </span>
        <span className="max-sm:sr-only">{full}</span>
      </>
    );

  if (href) {
    return (
      <a
        href={href}
        className={cls + ' no-underline'}
        style={style}
        title={title}
      >
        {content}
      </a>
    );
  }

  return (
    <span className={cls} style={style} title={title}>
      {content}
    </span>
  );
});
