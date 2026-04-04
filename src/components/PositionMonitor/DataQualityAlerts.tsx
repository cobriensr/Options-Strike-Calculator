import { useState } from 'react';
import type { DataQualityWarning } from './types';

interface DataQualityAlertsProps {
  warnings: readonly DataQualityWarning[];
}

const SEVERITY_STYLES: Record<DataQualityWarning['severity'], string> = {
  error: 'bg-danger/10 border-danger text-danger',
  warn: 'bg-caution/10 border-caution text-caution',
  info: 'bg-accent-bg border-accent text-accent',
};

const SEVERITY_ICONS: Record<DataQualityWarning['severity'], string> = {
  error: '\u26D4',
  warn: '\u26A0',
  info: '\u2139',
};

export default function DataQualityAlerts({
  warnings,
}: Readonly<DataQualityAlertsProps>) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  if (warnings.length === 0) return null;

  // Deduplicate by message to avoid duplicate key warnings
  // (e.g. multiple UNMATCHED_SHORT warnings)
  const deduped = warnings.filter(
    (w, i, arr) => arr.findIndex((x) => x.message === w.message) === i,
  );
  const visible = deduped.filter((w) => !dismissed.has(w.message));

  if (visible.length === 0) return null;

  const dismiss = (msg: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(msg);
      return next;
    });
  };

  return (
    <section
      className="flex flex-col gap-2"
      aria-label="Data quality alerts"
      data-testid="data-quality-alerts"
    >
      {visible.map((w, i) => (
        <div
          key={`${w.code}-${String(i)}`}
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${SEVERITY_STYLES[w.severity]}`}
          role="alert"
        >
          <span className="mt-0.5 shrink-0 text-sm" aria-hidden="true">
            {SEVERITY_ICONS[w.severity]}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-sm font-medium">{w.message}</div>
            {w.detail && (
              <div className="mt-0.5 font-sans text-xs opacity-80">
                {w.detail}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismiss(w.message)}
            className="shrink-0 cursor-pointer p-0.5 text-sm opacity-60 hover:opacity-100"
            aria-label={`Dismiss ${w.message}`}
          >
            {'\u2715'}
          </button>
        </div>
      ))}
    </section>
  );
}
