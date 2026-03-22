import type { TrafficSignal } from '../types';

/**
 * Classifies how much of the expected daily range has been consumed
 * by the opening 30-minute range.
 *
 * @param pctOfMedian  Opening range as a fraction of the median H-L (e.g. 0.35)
 * @returns signal (green/yellow/red), label, and actionable advice
 */
export function classifyOpeningRange(pctOfMedian: number): {
  signal: TrafficSignal;
  label: string;
  advice: string;
} {
  if (pctOfMedian < 0.4) {
    return {
      signal: 'green',
      label: 'RANGE INTACT',
      advice:
        'Opening range is small relative to the expected daily move. Good conditions to add positions.',
    };
  }
  if (pctOfMedian < 0.65) {
    return {
      signal: 'yellow',
      label: 'MODERATE',
      advice:
        'A meaningful portion of the expected range is used. Add positions with tighter deltas or smaller size.',
    };
  }
  return {
    signal: 'red',
    label: 'RANGE EXHAUSTED',
    advice:
      'The day is already running hot. Adding new positions carries elevated risk of further extension.',
  };
}
