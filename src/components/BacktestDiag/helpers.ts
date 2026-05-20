import type { Position } from './index';

export const POSITION_STORAGE_KEY = 'backtestDiag.position';

export function loadStoredPosition(): Position | null {
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Position).x === 'number' &&
      typeof (parsed as Position).y === 'number'
    ) {
      return { x: (parsed as Position).x, y: (parsed as Position).y };
    }
  } catch {
    // fall through
  }
  return null;
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
