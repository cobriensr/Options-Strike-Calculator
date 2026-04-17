/**
 * CompletenessMeter — live progress indicator rendered inside the pyramid
 * form modals.
 *
 * Shows a horizontal progress bar + "Complete: XX%" label that updates as
 * the user fills fields. Purpose is soft social pressure to fill more
 * fields: all pyramid form fields are optional, so there's no hard-block
 * on partial saves, but the meter nudges the user toward more complete
 * rows which improves downstream ML usefulness.
 *
 * Colour bands per spec:
 *   <33%  -> red
 *   33-66 -> amber
 *   >66%  -> green
 */

import { completenessColor } from './pyramid-form-helpers';

interface CompletenessMeterProps {
  readonly filled: number;
  readonly total: number;
}

export default function CompletenessMeter({
  filled,
  total,
}: CompletenessMeterProps) {
  const pct = total > 0 ? Math.round(Math.min(100, (filled / total) * 100)) : 0;
  const color = completenessColor(pct);

  return (
    <div
      className="flex items-center gap-3"
      role="group"
      aria-label="Form completeness"
    >
      <div
        className="bg-surface-alt h-1.5 flex-1 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span
        className="text-muted font-mono text-[10px] tabular-nums"
        data-testid="completeness-percent"
        aria-live="polite"
      >
        Complete: {pct}%
      </span>
    </div>
  );
}
