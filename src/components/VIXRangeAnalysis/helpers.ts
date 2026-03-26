import { theme } from '../../themes';
import type { VIXBucket } from '../../data/vixRangeStats';

export function zoneToColor(zone: VIXBucket['zone']): string {
  switch (zone) {
    case 'go':
      return theme.green;
    case 'caution':
      return theme.caution;
    case 'stop':
      return theme.red;
    case 'danger':
      return theme.red;
  }
}

export function heatColor(val: number): string {
  if (val >= 95) return theme.green;
  if (val >= 85) return theme.green;
  if (val >= 70) return theme.accent;
  if (val >= 50) return theme.caution;
  return theme.red;
}

export function heatBg(val: number): string {
  if (val >= 95) return 'rgba(21,128,61,0.10)';
  if (val >= 85) return 'rgba(21,128,61,0.06)';
  if (val >= 70) return 'rgba(29,78,216,0.05)';
  if (val >= 50) return 'rgba(232,163,23,0.06)';
  return 'rgba(185,28,28,0.08)';
}
