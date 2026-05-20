import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import type { DarkPoolLevel } from '../../hooks/useDarkPoolLevels';
import { formatDist, formatPremium } from './formatters';

export default function LevelRow({
  level,
  maxPremium,
  spxPrice,
}: Readonly<{
  level: DarkPoolLevel;
  maxPremium: number;
  spxPrice: number | null;
}>) {
  const barWidth = Math.max((level.totalPremium / maxPremium) * 100, 2);
  const isAtm = spxPrice != null && Math.abs(level.level - spxPrice) < 2.5;
  const distLabel = spxPrice != null ? formatDist(level.level, spxPrice) : null;

  // Color the distance label: above spot = green, below = red, at = accent
  const distColor = (() => {
    if (spxPrice == null) return theme.textMuted;
    if (isAtm) return theme.accent;
    return level.level > spxPrice ? theme.green : theme.red;
  })();

  return (
    <tr
      className="flex items-center gap-2 py-1.5"
      style={isAtm ? { backgroundColor: 'rgba(255,255,255,0.04)' } : undefined}
    >
      {/* Index level */}
      <td
        className="w-[52px] shrink-0 text-right font-mono text-sm font-bold"
        style={{ color: isAtm ? theme.accent : theme.text }}
      >
        {level.level}
      </td>

      {/* Distance from spot (only when spxPrice is known) */}
      {spxPrice != null && (
        <td
          className="w-[46px] shrink-0 text-right font-mono text-[10px]"
          style={{ color: distColor }}
        >
          {distLabel}
        </td>
      )}

      {/* Premium bar */}
      <td className="min-w-0 flex-1">
        <div
          className="h-[14px] rounded-sm transition-[width] duration-300"
          style={{
            width: `${barWidth}%`,
            backgroundColor: theme.accent,
            opacity: 0.6,
          }}
          aria-label={`${formatPremium(level.totalPremium)} premium`}
        />
      </td>

      {/* Premium value */}
      <td
        className="w-[56px] shrink-0 text-right font-mono text-xs font-semibold"
        style={{ color: theme.textSecondary }}
      >
        {formatPremium(level.totalPremium)}
      </td>

      {/* Block count */}
      <td className="text-muted w-[52px] shrink-0 text-right font-sans text-[10px]">
        {level.tradeCount} block{level.tradeCount !== 1 ? 's' : ''}
      </td>

      {/* Latest trade time */}
      <td className="text-muted w-[52px] shrink-0 text-right font-mono text-[10px]">
        {formatTimeCT(level.latestTime)}
      </td>
    </tr>
  );
}
