import type { Theme } from '../themes';
import { tint } from '../utils/ui-utils';
import { findBucket, findFineStat, estimateRange } from '../data/vixRangeStats';

interface Props {
  readonly th: Theme;
  readonly vix: number;
  readonly spot: number; // SPX spot for points display
}

/**
 * Compact contextual card showing historical regime stats for the current VIX level.
 * Designed to sit directly below the VIX input inside the IV SectionBox.
 */
export default function VIXRegimeCard({ th, vix, spot }: Props) {
  const bucket = findBucket(vix);
  const fine = findFineStat(vix);
  const est = estimateRange(vix);
  if (!bucket) return null;

  const zone = bucket.zone;
  const zoneConfig = {
    go: {
      color: th.green,
      bg: tint(th.green, '12'),
      border: tint(th.green, '30'),
      label: 'GREEN',
      advice: 'Favorable for iron condors',
    },
    caution: {
      color: th.caution,
      bg: tint(th.caution, '12'),
      border: tint(th.caution, '30'),
      label: 'CAUTION',
      advice: 'Widen strikes or reduce size',
    },
    stop: {
      color: th.red,
      bg: tint(th.red, '12'),
      border: tint(th.red, '30'),
      label: 'ELEVATED',
      advice: 'Consider sitting out',
    },
    danger: {
      color: th.red,
      bg: tint(th.red, '18'),
      border: tint(th.red, '40'),
      label: 'EXTREME',
      advice: 'Do not sell iron condors',
    },
  }[zone];

  const medPts = Math.round((est.medHL / 100) * spot);
  const p90Pts = Math.round((est.p90HL / 100) * spot);
  const medOCPts = Math.round((est.medOC / 100) * spot);

  return (
    <div
      className="mt-3.5 rounded-[10px] px-4 py-3.5"
      style={{
        backgroundColor: zoneConfig.bg,
        border: '1.5px solid ' + zoneConfig.border,
      }}
    >
      {/* Header row */}
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="h-2.5 w-2.5 rounded-full"
            style={{
              backgroundColor: zoneConfig.color,
              boxShadow: '0 0 6px ' + tint(zoneConfig.color, '66'),
            }}
          />
          <span
            className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
            style={{ color: zoneConfig.color }}
          >
            {zoneConfig.label} REGIME
          </span>
        </div>
        <span className="text-muted font-mono text-[10px]">
          {(fine?.count ?? bucket.count).toLocaleString()} historical days
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <MiniStat
          label="Median Range"
          value={est.medHL.toFixed(2) + '%'}
          sub={medPts + ' pts'}
          color={th.accent}
        />
        <MiniStat
          label="90th Pctile"
          value={est.p90HL.toFixed(2) + '%'}
          sub={p90Pts + ' pts'}
          color={zone === 'go' ? th.accent : zoneConfig.color}
        />
        <MiniStat
          label={'Med. O\u2192C'}
          value={est.medOC.toFixed(2) + '%'}
          sub={medOCPts + ' pts settle'}
          color={th.green}
        />
      </div>

      {/* Advice line */}
      <div
        className="mt-2.5 pt-2 font-sans text-[11px] font-semibold"
        style={{
          borderTop: '1px solid ' + zoneConfig.border,
          color: zoneConfig.color,
        }}
      >
        {zoneConfig.advice}
        <span className="text-muted ml-1.5 font-normal">
          {'\u2014'} {bucket.over2HL}% of days exceed 2% range
        </span>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div>
      <div className="text-tertiary font-sans text-[10px] font-bold tracking-[0.06em] uppercase">
        {label}
      </div>
      <div
        className="mt-0.5 font-mono text-[15px] font-semibold"
        style={{ color }}
      >
        {value}
      </div>
      <div className="text-muted font-mono text-[10px]">{sub}</div>
    </div>
  );
}
