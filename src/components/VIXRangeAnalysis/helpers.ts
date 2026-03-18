import type { Theme } from '../../themes';
import type { VIXBucket } from '../../data/vixRangeStats';

export function zoneToColor(zone: VIXBucket['zone'], th: Theme): string {
  switch (zone) {
    case 'go':
      return th.green;
    case 'caution':
      return th.caution;
    case 'stop':
      return th.red;
    case 'danger':
      return th.red;
  }
}

export function heatColor(val: number, th: Theme): string {
  if (val >= 95) return th.green;
  if (val >= 85) return th.green;
  if (val >= 70) return th.accent;
  if (val >= 50) return th.caution;
  return th.red;
}

export function heatBg(val: number): string {
  if (val >= 95) return 'rgba(21,128,61,0.10)';
  if (val >= 85) return 'rgba(21,128,61,0.06)';
  if (val >= 70) return 'rgba(29,78,216,0.05)';
  if (val >= 50) return 'rgba(232,163,23,0.06)';
  return 'rgba(185,28,28,0.08)';
}
