import { memo, type ReactNode } from 'react';
import {
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_BASE_COMPACT,
  CHIP_INACTIVE,
  type FilterChipColor,
} from './filter-toolbar-tokens.js';

interface FilterChipProps {
  /** Visual + a11y active state. When true, applies `activeColor`. */
  active?: boolean;
  /** Color palette when `active` is true. Defaults to neutral. */
  activeColor?: FilterChipColor;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /**
   * Optional aria-pressed pass-through. Omitted when undefined so caller
   * controls whether the chip advertises toggle semantics (steppers don't,
   * radio-style groups do).
   */
  ariaPressed?: boolean;
  ariaLabel?: string;
  /** Pass-through for Playwright / vitest selectors. */
  testId?: string;
  /** Escape hatch for one-off classes. Rare. */
  className?: string;
  /**
   * Opt-in dense variant (CHIP_BASE_COMPACT). Only the LotteryFinder /
   * SilentBoom row-1 toolbars use it; everything else keeps the default.
   */
  size?: 'compact';
  children: ReactNode;
}

export const FilterChip = memo(function FilterChip({
  active = false,
  activeColor,
  onClick,
  disabled,
  title,
  ariaPressed,
  ariaLabel,
  testId,
  className,
  size,
  children,
}: FilterChipProps) {
  const baseClass = size === 'compact' ? CHIP_BASE_COMPACT : CHIP_BASE;
  const stateClass =
    active && activeColor ? CHIP_ACTIVE[activeColor] : CHIP_INACTIVE;
  const extraClass = className ? ` ${className}` : '';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={ariaPressed}
      aria-label={ariaLabel}
      data-testid={testId}
      className={`${baseClass} ${stateClass}${extraClass} disabled:opacity-40 disabled:hover:border-neutral-700 disabled:hover:text-neutral-300`}
    >
      {children}
    </button>
  );
});
