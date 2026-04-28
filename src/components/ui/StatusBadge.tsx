import { memo } from 'react';

/** Status badge with tinted background — used in the header for LIVE, CLOSED, BACKTEST, etc. */
export const StatusBadge = memo(function StatusBadge({
  label,
  color,
  dot,
  title,
  href,
}: {
  label: string;
  color: string;
  dot?: boolean;
  title?: string;
  href?: string;
}) {
  const cls = 'rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold';
  const style = {
    backgroundColor: `color-mix(in srgb, ${color} 9%, transparent)`,
    color,
  };
  const content = (
    <>
      {dot && '● '}
      {label}
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
