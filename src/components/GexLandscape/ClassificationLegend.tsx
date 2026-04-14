/**
 * ClassificationLegend — bottom-row legend mapping each of the four
 * (gamma × charm) classifications to a short plain-English description.
 */

import { CLASS_META } from './constants';
import type { GexClassification } from './types';

const LEGEND: Array<[GexClassification, string]> = [
  ['max-launchpad', 'Neg γ + Pos θ_t — accelerant, builds into close'],
  ['fading-launchpad', 'Neg γ + Neg θ_t — accelerant that weakens over time'],
  ['sticky-pin', 'Pos γ + Pos θ_t — wall that strengthens into close'],
  ['weakening-pin', 'Pos γ + Neg θ_t — wall losing grip as day ages'],
];

export function ClassificationLegend() {
  return (
    <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 px-1">
      {LEGEND.map(([cls, desc]) => {
        const m = CLASS_META[cls];
        return (
          <div key={cls} className="flex items-center gap-1.5">
            <span
              className={`inline-block rounded px-1 py-0 font-mono text-[9px] font-semibold ${m.badgeBg} ${m.badgeText}`}
            >
              {m.badge}
            </span>
            <span className="text-muted font-mono text-[9px]">{desc}</span>
          </div>
        );
      })}
    </div>
  );
}
