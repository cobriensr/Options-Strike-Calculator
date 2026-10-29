/**
 * ClassificationLegend — bottom-row legend mapping each of the four
 * (gamma × charm) classifications to the signs that define it, in GEXBot's
 * taker-side sign (no market-maker reading; owner decision D1 revised).
 */

import { CLASS_META } from './constants';
import type { GexClassification } from './types';

const LEGEND: Array<[GexClassification, string]> = [
  ['max-launchpad', 'traders net short gamma, net long charm'],
  ['fading-launchpad', 'traders net short gamma, net short charm'],
  ['sticky-pin', 'traders net long gamma, net long charm'],
  ['weakening-pin', 'traders net long gamma, net short charm'],
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
