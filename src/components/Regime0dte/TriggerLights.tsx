/**
 * TriggerLights — three latching "down-only" trigger lights for the 0DTE
 * Gamma Regime panel. Each light is lit (amber) once its trigger has fired
 * and shows the CT clock time it fired at; unlit lights are dim slate.
 *
 * Pure / presentational: props in, markup out. No data fetching.
 *
 *   - mostly-red     — ≥4 red / ≤1 green 30-min candles by 11:00 CT
 *   - IV-break       — put-IV exceeded the morning-range high by >2%
 *   - midday-deep-neg — net GEX still deep-negative after 12:30 CT
 */

import { memo } from 'react';
import type { Regime0dteTriggers } from '../../hooks/useRegime0dte';
import { formatCtMin } from './format';

interface LightSpec {
  key: string;
  label: string;
  fired: boolean;
  atCtMin: number | null;
}

function Light({ label, fired, atCtMin }: Omit<LightSpec, 'key'>) {
  const dotClass = fired
    ? 'bg-amber-400 shadow-[0_0_6px_1px_rgba(251,191,36,0.6)]'
    : 'bg-slate-700';
  const textClass = fired ? 'text-amber-200' : 'text-slate-500';
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`inline-block h-2.5 w-2.5 rounded-full ${dotClass}`}
        aria-hidden="true"
      />
      <span className={`text-xs ${textClass}`}>
        {label}
        {fired && (
          <span className="ml-1 font-mono text-amber-300 tabular-nums">
            {formatCtMin(atCtMin)}
          </span>
        )}
      </span>
    </div>
  );
}

interface TriggerLightsProps {
  triggers: Regime0dteTriggers;
}

function TriggerLightsImpl({ triggers }: TriggerLightsProps) {
  const lights: LightSpec[] = [
    {
      key: 'mostlyRed',
      label: 'mostly-red',
      fired: triggers.mostlyRed.fired,
      atCtMin: triggers.mostlyRed.atCtMin,
    },
    {
      key: 'ivBreak',
      label: 'IV-break',
      fired: triggers.ivBreak.fired,
      atCtMin: triggers.ivBreak.atCtMin,
    },
    {
      key: 'middayDeepNeg',
      label: 'midday-deep-neg',
      fired: triggers.middayDeepNeg.fired,
      atCtMin: triggers.middayDeepNeg.atCtMin,
    },
  ];

  return (
    <ul
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5"
      aria-label="Down-side confirmation triggers"
    >
      {lights.map((l) => (
        <li key={l.key}>
          <Light label={l.label} fired={l.fired} atCtMin={l.atCtMin} />
        </li>
      ))}
    </ul>
  );
}

export const TriggerLights = memo(TriggerLightsImpl);
