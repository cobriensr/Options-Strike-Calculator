/**
 * Sign-only colour for ladder rows. The shared sky (+) / violet (−) pair
 * from the gamma-sign palette, the same above and below spot: neither model
 * says whether a level is support or resistance, so colour carries the sign
 * of the change and nothing else.
 */

import {
  GAMMA_SIGN_CLASSES,
  GAMMA_SIGN_HEX,
} from '../../GexLandscape/constants';

export interface ChangeSignStyle {
  /** Tailwind text colour class for the row. */
  text: string;
  /** Hex for the inline bar fill. */
  barHex: string;
}

export function changeSignClasses(change: number): ChangeSignStyle {
  const side = change >= 0 ? 'long' : 'short';
  return {
    text: GAMMA_SIGN_CLASSES[side].color,
    barHex: GAMMA_SIGN_HEX[side],
  };
}
