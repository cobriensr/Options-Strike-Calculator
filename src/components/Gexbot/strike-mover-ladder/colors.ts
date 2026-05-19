/**
 * Pure color/tone classifier for ladder rows. Encodes the trading-aware
 * 4-quadrant matrix from the spec plus an ATM-magnet override.
 *
 *   Below spot · +Δ → floor strengthening   → emerald
 *   Below spot · −Δ → floor weakening       → amber + ▽
 *   Above spot · −Δ → ceiling strengthening → rose
 *   Above spot · +Δ → ceiling weakening     → yellow + ▽
 *   Within ±ATM_BAND_BPS → magnet           → violet + ◈ ATM
 *
 * Spec: docs/superpowers/specs/strike-mover-ladder-2026-05-19.md
 */

import { ATM_BAND_BPS, type ClassifiedRow } from './types';

export function classifyRow(
  strike: number,
  spot: number,
  change: number,
): ClassifiedRow {
  const bandWidth = spot * (ATM_BAND_BPS / 10_000);
  const distance = Math.abs(strike - spot);
  if (distance <= bandWidth) {
    return {
      side: 'atm',
      tone: 'magnet',
      toneClass: 'text-violet-300',
      marker: '◈ ATM',
    };
  }
  const positive = change > 0;
  const above = strike > spot;
  if (above) {
    return positive
      ? {
          side: 'above',
          tone: 'weakening',
          toneClass: 'text-yellow-300',
          marker: '▽',
        }
      : {
          side: 'above',
          tone: 'strengthening',
          toneClass: 'text-rose-300',
          marker: null,
        };
  }
  return positive
    ? {
        side: 'below',
        tone: 'strengthening',
        toneClass: 'text-emerald-300',
        marker: null,
      }
    : {
        side: 'below',
        tone: 'weakening',
        toneClass: 'text-amber-300',
        marker: '▽',
      };
}
