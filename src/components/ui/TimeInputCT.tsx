/**
 * TimeInputCT — canonical time-of-day input anchored to **Central Time**.
 *
 * Wraps the native `<input type="time">` (24-hour HH:MM, 1-minute
 * granularity) with consistent styling and the documented invariant that
 * the value represents a Central Time wall-clock — matching the rest of
 * this app's TZ convention. The input itself is timezone-naive, so this
 * is by convention only; callers must NOT pass the value through
 * `new Date(value)` (which interprets as browser-local). For UTC ISO
 * conversion, use `ctWallClockToUtcIso(dateStr, h * 60 + m)` from
 * `src/utils/timezone.ts`.
 *
 * Use this anywhere a feature needs a CT-anchored time picker. It
 * intentionally does NOT support 12-hour or AM/PM modes — the codebase
 * standardizes on 24-hour CT to eliminate the conversion-error surface.
 */

import { useId } from 'react';

export interface TimeInputCTProps {
  /** HH:MM string (24-hour) or empty. */
  value: string;
  onChange: (next: string) => void;
  /** Visible label. The TZ suffix " (Central Time)" is appended automatically. */
  label: string;
  /** Optional explicit id; one is generated if omitted. */
  id?: string;
  /** Earliest accepted time as HH:MM (24-hour CT). Inclusive. */
  min?: string;
  /** Latest accepted time as HH:MM (24-hour CT). Inclusive. */
  max?: string;
  /** Render the label visually (default) or hide it accessibly. */
  labelVisible?: boolean;
  /** Placeholder text shown when empty. */
  placeholder?: string;
  /** Tailwind class overrides for the input element. */
  className?: string;
}

const DEFAULT_INPUT_CLASS =
  'border-edge bg-surface-alt text-text rounded border px-1.5 py-0.5 font-mono text-xs';

export function TimeInputCT({
  value,
  onChange,
  label,
  id,
  min,
  max,
  labelVisible = true,
  placeholder,
  className,
}: Readonly<TimeInputCTProps>) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const ariaLabel = `${label} (Central Time)`;

  return (
    <span className="inline-flex items-center gap-1.5">
      {labelVisible ? (
        <label htmlFor={inputId} className="text-muted text-xs">
          {label}
        </label>
      ) : (
        <label htmlFor={inputId} className="sr-only">
          {ariaLabel}
        </label>
      )}
      <input
        id={inputId}
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        step={60}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={className ?? DEFAULT_INPUT_CLASS}
      />
    </span>
  );
}
