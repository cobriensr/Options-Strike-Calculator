/**
 * DateInput — canonical styled date input for this app.
 *
 * Wraps the native `<input type="date">` (YYYY-MM-DD) with consistent
 * styling. The input itself is timezone-naive — it just edits a
 * YYYY-MM-DD string.
 *
 * Trading-day convention: callers compare the value against "today"
 * using `getETToday()` from `src/utils/timezone.ts` (the trading
 * calendar is anchored to Eastern Time). The component does not
 * enforce or surface this convention; it is owned by callers.
 *
 * Sister primitive to `TimeInputCT` — they're typically composed
 * together by sections that pick a trading-day calendar date plus an
 * intraday time-of-day for replay/scrubbing.
 */

import { useId } from 'react';

export interface DateInputProps {
  /** YYYY-MM-DD string or empty. */
  value: string;
  onChange: (next: string) => void;
  /** Visible label. Also used as the accessible name. */
  label: string;
  /** Optional explicit id; one is generated if omitted. */
  id?: string;
  /** Earliest accepted date as YYYY-MM-DD. Inclusive. */
  min?: string;
  /** Latest accepted date as YYYY-MM-DD. Inclusive. */
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

export function DateInput({
  value,
  onChange,
  label,
  id,
  min,
  max,
  labelVisible = true,
  list,
  className,
}: Readonly<DateInputProps>) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <span className="inline-flex items-center gap-1.5">
      {labelVisible ? (
        <label htmlFor={inputId} className="text-muted text-xs">
          {label}
        </label>
      ) : (
        <label htmlFor={inputId} className="sr-only">
          {label}
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
        aria-label={label}
        className={className ?? DEFAULT_INPUT_CLASS}
      />
    </span>
  );
}
