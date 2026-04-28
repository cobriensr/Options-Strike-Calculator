/**
 * DateInputET — canonical date input anchored to **Eastern Time**
 * (the trading-day convention).
 *
 * Wraps the native `<input type="date">` (YYYY-MM-DD) with consistent
 * styling and the documented invariant that the value represents an
 * Eastern Time calendar date — matching the rest of this app's
 * trading-day convention.
 *
 * The native input is timezone-naive (it just edits a YYYY-MM-DD
 * string), so the ET anchoring is by convention only. Callers comparing
 * the value against "today" should use `getETToday()` from
 * `src/utils/timezone.ts` rather than rolling their own date helper.
 *
 * Sister primitive to `TimeInputCT` — they're typically composed
 * together by sections that pick a trading-day calendar date plus an
 * intraday time-of-day for replay/scrubbing.
 */

import { useId } from 'react';

export interface DateInputETProps {
  /** YYYY-MM-DD string or empty. */
  value: string;
  onChange: (next: string) => void;
  /** Visible label. The TZ suffix " (Eastern Time)" is appended automatically. */
  label: string;
  /** Optional explicit id; one is generated if omitted. */
  id?: string;
  /** Earliest accepted date as YYYY-MM-DD (ET). Inclusive. */
  min?: string;
  /** Latest accepted date as YYYY-MM-DD (ET). Inclusive. */
  max?: string;
  /** Render the label visually (default) or hide it accessibly. */
  labelVisible?: boolean;
  /** Optional `<datalist>` id for available-date hints (e.g. archived dates). */
  list?: string;
  /** Tailwind class overrides for the input element. */
  className?: string;
}

const DEFAULT_INPUT_CLASS =
  'border-edge bg-surface-alt text-text rounded border px-1.5 py-0.5 font-mono text-xs';

export function DateInputET({
  value,
  onChange,
  label,
  id,
  min,
  max,
  labelVisible = true,
  list,
  className,
}: Readonly<DateInputETProps>) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const ariaLabel = `${label} (Eastern Time)`;

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
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        list={list}
        aria-label={ariaLabel}
        className={className ?? DEFAULT_INPUT_CLASS}
      />
    </span>
  );
}
