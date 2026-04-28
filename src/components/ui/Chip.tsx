import { memo } from 'react';

/** Chip toggle button */
export const Chip = memo(function Chip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={
        'inline-flex min-h-[44px] cursor-pointer items-center rounded-full border-[1.5px] px-3.5 py-1.5 font-mono text-[13px] font-medium transition-all duration-100 lg:min-h-0 ' +
        (active
          ? 'border-chip-active-border bg-chip-active-bg text-chip-active-text'
          : 'border-chip-border bg-chip-bg text-chip-text hover:border-edge-heavy hover:bg-surface-alt')
      }
    >
      {label}
    </button>
  );
});
