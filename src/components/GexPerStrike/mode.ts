/**
 * ViewMode accessors for GEX-per-strike data.
 *
 * Each strike level carries OI, VOL, and directionalized bid/ask variants
 * of gamma and its higher-order derivatives. These helpers pick the right
 * component based on the active view mode, collapsing the switch-case
 * from the render loop.
 *
 * DIR mode only has gamma bid/ask data from UW — charm and vanna fall
 * back to OI values there, because UW does not break down charm/vanna
 * per bid/ask.
 */

import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';

export type ViewMode = 'oi' | 'vol' | 'dir';

export function getNetGamma(s: GexStrikeLevel, mode: ViewMode): number {
  if (mode === 'oi') return s.netGamma;
  if (mode === 'vol') return s.netGammaVol;
  return s.callGammaAsk + s.callGammaBid + s.putGammaAsk + s.putGammaBid;
}

export function getNetCharm(s: GexStrikeLevel, mode: ViewMode): number {
  return mode === 'vol' ? s.netCharmVol : s.netCharm;
}

export function getNetVanna(s: GexStrikeLevel, mode: ViewMode): number {
  return mode === 'vol' ? s.netVannaVol : s.netVanna;
}

export function getCallGamma(s: GexStrikeLevel, mode: ViewMode): number {
  if (mode === 'oi') return s.callGammaOi;
  if (mode === 'vol') return s.callGammaVol;
  return s.callGammaAsk + s.callGammaBid;
}

export function getPutGamma(s: GexStrikeLevel, mode: ViewMode): number {
  if (mode === 'oi') return s.putGammaOi;
  if (mode === 'vol') return s.putGammaVol;
  return s.putGammaAsk + s.putGammaBid;
}
