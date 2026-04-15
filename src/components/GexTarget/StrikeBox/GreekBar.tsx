/**
 * GreekBar — single horizontal bar visualizing one greek (CHEX/DEX/VEX) value.
 *
 * Width = tanh(|value| / scale) × BAR_MAX_W. The tanh saturates the bar at
 * ~75% width when |value| ≈ 1×scale and ~96% at 2×scale, so outliers don't
 * push everything else into invisibility. Color is green for positive, red
 * for negative, muted gray for values at or below the near-zero threshold.
 *
 * Memoized so unchanged rows skip re-render when the parent leaderboard
 * polls but a strike's greek values haven't moved.
 */

import { memo } from 'react';
import { theme } from '../../../themes';
import { BAR_H, BAR_MAX_W } from './bars';

interface GreekBarProps {
  value: number;
  scale: number;
  nearZeroThreshold: number;
}

export const GreekBar = memo(function GreekBar({
  value,
  scale,
  nearZeroThreshold,
}: GreekBarProps) {
  const abs = Math.abs(value);
  const isNearZero = abs <= nearZeroThreshold;
  const width = Math.tanh(abs / scale) * BAR_MAX_W;

  let barColor: string;
  if (isNearZero) {
    barColor = theme.textMuted;
  } else if (value > 0) {
    barColor = theme.green;
  } else {
    barColor = theme.red;
  }

  return (
    <div style={{ width: BAR_MAX_W, height: BAR_H, position: 'relative' }}>
      <div
        style={{
          width,
          height: BAR_H,
          backgroundColor: barColor,
          borderRadius: 2,
          opacity: isNearZero ? 0.4 : 0.85,
        }}
      />
    </div>
  );
});
