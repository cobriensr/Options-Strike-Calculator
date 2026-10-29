import { describe, expect, it } from 'vitest';

import { changeSignClasses } from '../components/Gexbot/strike-mover-ladder/colors';
import {
  GAMMA_SIGN_CLASSES,
  GAMMA_SIGN_HEX,
} from '../components/GexLandscape/constants';

describe('changeSignClasses', () => {
  it('paints a positive change with the sky (long) pair', () => {
    const c = changeSignClasses(1_600);
    expect(c.text).toBe(GAMMA_SIGN_CLASSES.long.color);
    expect(c.barHex).toBe(GAMMA_SIGN_HEX.long);
  });

  it('paints a negative change with the violet (short) pair', () => {
    const c = changeSignClasses(-820);
    expect(c.text).toBe(GAMMA_SIGN_CLASSES.short.color);
    expect(c.barHex).toBe(GAMMA_SIGN_HEX.short);
  });

  it('depends only on the sign, not the size', () => {
    expect(changeSignClasses(1)).toEqual(changeSignClasses(9_000_000));
    expect(changeSignClasses(-1)).toEqual(changeSignClasses(-9_000_000));
  });

  it('uses no green, amber or red palette colours', () => {
    const all = JSON.stringify([changeSignClasses(5), changeSignClasses(-5)]);
    expect(all).not.toMatch(/emerald|green|amber|rose|red|yellow/);
  });
});
