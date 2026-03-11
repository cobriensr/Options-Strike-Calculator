import type { Theme } from '../themes';
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
    go:      { color: th.green, bg: th.green + '12', border: th.green + '30', label: 'GREEN', advice: 'Favorable for iron condors' },
    caution: { color: '#E8A317', bg: '#E8A31712', border: '#E8A31730', label: 'CAUTION', advice: 'Widen strikes or reduce size' },
    stop:    { color: th.red,   bg: th.red + '12',   border: th.red + '30',   label: 'ELEVATED', advice: 'Consider sitting out' },
    danger:  { color: th.red,   bg: th.red + '18',   border: th.red + '40',   label: 'EXTREME', advice: 'Do not sell iron condors' },
  }[zone];

  const medPts = Math.round(est.medHL / 100 * spot);
  const p90Pts = Math.round(est.p90HL / 100 * spot);
  const medOCPts = Math.round(est.medOC / 100 * spot);

  return (
    <div style={{
      marginTop: 14,
      padding: '14px 16px',
      backgroundColor: zoneConfig.bg,
      border: '1.5px solid ' + zoneConfig.border,
      borderRadius: 10,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            backgroundColor: zoneConfig.color,
            boxShadow: '0 0 6px ' + zoneConfig.color + '66',
          }} />
          <span style={{
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const,
            letterSpacing: '0.12em', color: zoneConfig.color,
            fontFamily: "'Outfit', sans-serif",
          }}>
            {zoneConfig.label} REGIME
          </span>
        </div>
        <span style={{
          fontSize: 10, color: th.textMuted,
          fontFamily: "'DM Mono', monospace",
        }}>
          {(fine?.count ?? bucket.count).toLocaleString()} historical days
        </span>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <MiniStat
          th={th}
          label="Median Range"
          value={est.medHL.toFixed(2) + '%'}
          sub={medPts + ' pts'}
          color={th.accent}
        />
        <MiniStat
          th={th}
          label="90th Pctile"
          value={est.p90HL.toFixed(2) + '%'}
          sub={p90Pts + ' pts'}
          color={zone === 'go' ? th.accent : zoneConfig.color}
        />
        <MiniStat
          th={th}
          label={'Med. O\u2192C'}
          value={est.medOC.toFixed(2) + '%'}
          sub={medOCPts + ' pts settle'}
          color={th.green}
        />
      </div>

      {/* Advice line */}
      <div style={{
        marginTop: 10, paddingTop: 8,
        borderTop: '1px solid ' + zoneConfig.border,
        fontSize: 11, color: zoneConfig.color,
        fontFamily: "'Outfit', sans-serif", fontWeight: 600,
      }}>
        {zoneConfig.advice}
        <span style={{ color: th.textMuted, fontWeight: 400, marginLeft: 6 }}>
          {'\u2014'} {bucket.over2HL}% of days exceed 2% range
        </span>
      </div>
    </div>
  );
}

function MiniStat({ th, label, value, sub, color }: {
  th: Theme; label: string; value: string; sub: string; color: string;
}) {
  return (
    <div>
      <div style={{
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
        letterSpacing: '0.06em', color: th.textTertiary,
        fontFamily: "'Outfit', sans-serif",
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 15, fontWeight: 600,
        fontFamily: "'DM Mono', monospace",
        color, marginTop: 2,
      }}>
        {value}
      </div>
      <div style={{
        fontSize: 10, color: th.textMuted,
        fontFamily: "'DM Mono', monospace",
      }}>
        {sub}
      </div>
    </div>
  );
}