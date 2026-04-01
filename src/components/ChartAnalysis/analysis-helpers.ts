import { theme } from '../../themes';

export function structureColor(s: string): string {
  if (s === 'IRON CONDOR') return theme.accent;
  if (s === 'PUT CREDIT SPREAD') return theme.red;
  if (s === 'CALL CREDIT SPREAD') return theme.green;
  return theme.caution;
}

export function confidenceColor(c: string): string {
  if (c === 'HIGH') return theme.green;
  if (c === 'MODERATE') return theme.caution;
  return theme.red;
}

export function signalColor(s: string): string {
  if (
    s === 'BEARISH' ||
    s === 'CONTRADICTS' ||
    s === 'UNFAVORABLE' ||
    s === 'DECAYING' ||
    s === 'NEGATIVE'
  )
    return theme.red;
  if (
    s === 'BULLISH' ||
    s === 'CONFIRMS' ||
    s === 'FAVORABLE' ||
    s === 'SUPPORTIVE' ||
    s === 'POSITIVE'
  )
    return theme.green;
  if (s === 'NEUTRAL' || s === 'NOT PROVIDED') return theme.textMuted;
  return theme.caution;
}
