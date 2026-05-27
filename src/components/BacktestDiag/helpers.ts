import type { Position } from './index';

export const POSITION_STORAGE_KEY = 'backtestDiag.position';
export const COLLAPSED_STORAGE_KEY = 'backtestDiag.collapsed';

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

// Collapsed state uses a flat '1' / absent encoding rather than JSON
// for the same reason as the alert mute key: a one-bit flag doesn't
// benefit from parse overhead, and absence == default keeps the
// storage surface clean.
export function loadStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStoredCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(COLLAPSED_STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable (private mode, quota); ignore
  }
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
