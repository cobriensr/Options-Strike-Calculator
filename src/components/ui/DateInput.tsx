/**
 * DateInput — canonical styled date input for this app.
 *
 * Wraps the native `<input type="date">` (YYYY-MM-DD) with consistent
 * styling. The input itself is timezone-naive — it just edits a
 * YYYY-MM-DD string.
 *
 * An incomplete or pre-1000 date is a draft until it is complete or you
 * leave the field. A draft shows as typed and is not passed to `onChange`;
 * leaving the field while it is still a draft passes '' once (a panel that
 * follows today reads that as "today"). A complete date is passed on as soon
 * as it is whole. See the comment at the draft state below for why.
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

import { useId, useState } from 'react';

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

/**
 * Text that is not yet a date to act on: the empty string, or a year before
 * 1000 (it starts with "0", e.g. 0002-04-09 while 2026 is being typed).
 */
function isDraftText(text: string): boolean {
  return text === '' || text.startsWith('0');
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

  // An incomplete or pre-1000 date is a draft until it is complete or you
  // leave the field. A native date input fires `input` with '' whenever its
  // value goes invalid: the first "0" of a zero-padded month or day does it,
  // as does a cleared segment. Typing the year digit by digit fires valid but
  // meaningless dates on the way (0002-04-09, 0020-04-09, 0202-04-09). A
  // parent that turns '' into a date (a panel that follows today) would
  // rewrite the controlled field and lose the segments typed so far, and each
  // of those dates would reach the parent and start a fetch. So both are kept
  // as a local draft: the raw text, shown as typed, and told to the parent
  // only if the field is left as a draft ('' = follow today, the same as an
  // incomplete field).
  //
  // `from` is the `value` the draft was taken against, not a copy of it. A
  // new value from outside (the LIVE button, the midnight roll) drops the
  // draft during render, with no effect: React's "adjust state when a prop
  // changes" pattern, which re-renders at once and commits only the second
  // pass. So a lapsed draft cannot come back if `value` returns to what it
  // was, blur or no blur.
  const [pending, setPending] = useState<{ from: string; text: string } | null>(
    null,
  );
  if (pending !== null && pending.from !== value) setPending(null);

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
        value={pending ? pending.text : value}
        onChange={(e) => {
          const next = e.target.value;
          if (isDraftText(next)) {
            setPending({ from: value, text: next });
            return;
          }
          setPending(null);
          onChange(next);
        }}
        onBlur={() => {
          setPending(null);
          if (pending) onChange('');
        }}
        min={min}
        max={max}
        list={list}
        aria-label={label}
        className={className ?? DEFAULT_INPUT_CLASS}
      />
    </span>
  );
}
