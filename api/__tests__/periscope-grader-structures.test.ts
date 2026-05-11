/**
 * Coverage for Appendix A — per-structure outcome rules. Each
 * structure name has a happy + miss case.
 *
 * Phase 2 of docs/superpowers/specs/periscope-calibration-grading-2026-05-11.md.
 */

import { describe, it, expect } from 'vitest';
import {
  gradeStructure,
  gradeStructureList,
  type StructureGradeInput,
} from '../_lib/periscope-grader-structures.js';

function input(
  overrides: Partial<StructureGradeInput> = {},
): StructureGradeInput {
  return {
    eodReturnPct: 0,
    slotSpot: 5800,
    eodClose: 5800,
    atrPct: 0.002, // 0.2%
    gammaFloor: 5780,
    gammaCeiling: 5820,
    magnet: 5800,
    icBlownAtEod: false,
    ...overrides,
  };
}

describe('gradeStructure: debit_put_spread', () => {
  it('correct when EOD return ≤ -1 ATR', () => {
    expect(
      gradeStructure(
        'debit_put_spread',
        input({ eodReturnPct: -0.0025, atrPct: 0.002 }),
      ),
    ).toBe(true);
  });
  it('incorrect when EOD return positive', () => {
    expect(
      gradeStructure(
        'debit_put_spread',
        input({ eodReturnPct: 0.005, atrPct: 0.002 }),
      ),
    ).toBe(false);
  });
});

describe('gradeStructure: debit_call_spread', () => {
  it('correct when EOD return ≥ 1 ATR', () => {
    expect(
      gradeStructure(
        'debit_call_spread',
        input({ eodReturnPct: 0.0025, atrPct: 0.002 }),
      ),
    ).toBe(true);
  });
  it('incorrect on flat tape', () => {
    expect(
      gradeStructure(
        'debit_call_spread',
        input({ eodReturnPct: 0.001, atrPct: 0.002 }),
      ),
    ).toBe(false);
  });
});

describe('gradeStructure: directional_long_call / naked_directional_call', () => {
  it('long_call correct when EOD return ≥ 0.3%', () => {
    expect(
      gradeStructure('directional_long_call', input({ eodReturnPct: 0.004 })),
    ).toBe(true);
  });
  it('long_call incorrect when EOD flat', () => {
    expect(
      gradeStructure('directional_long_call', input({ eodReturnPct: 0.001 })),
    ).toBe(false);
  });
  it('naked_directional_call mirrors long_call rule', () => {
    expect(
      gradeStructure('naked_directional_call', input({ eodReturnPct: 0.004 })),
    ).toBe(true);
  });
});

describe('gradeStructure: directional_long_put / naked_directional_put', () => {
  it('long_put correct when EOD return ≤ -0.3%', () => {
    expect(
      gradeStructure('directional_long_put', input({ eodReturnPct: -0.005 })),
    ).toBe(true);
  });
  it('naked_directional_put mirrors long_put rule', () => {
    expect(
      gradeStructure('naked_directional_put', input({ eodReturnPct: -0.005 })),
    ).toBe(true);
  });
});

describe('gradeStructure: iron_condor', () => {
  it('correct when ic not blown', () => {
    expect(gradeStructure('iron_condor', input({ icBlownAtEod: false }))).toBe(
      true,
    );
  });
  it('incorrect when blown', () => {
    expect(gradeStructure('iron_condor', input({ icBlownAtEod: true }))).toBe(
      false,
    );
  });
  it('null when ic_blown unknown', () => {
    expect(
      gradeStructure('iron_condor', input({ icBlownAtEod: null })),
    ).toBeNull();
  });
});

describe('gradeStructure: iron_butterfly', () => {
  it('correct when EOD close within 5pt of magnet', () => {
    expect(
      gradeStructure('iron_butterfly', input({ magnet: 5800, eodClose: 5803 })),
    ).toBe(true);
  });
  it('incorrect when EOD close > 5pt from magnet', () => {
    expect(
      gradeStructure('iron_butterfly', input({ magnet: 5800, eodClose: 5810 })),
    ).toBe(false);
  });
});

describe('gradeStructure: broken_wing_butterfly', () => {
  it('correct within 10pt of magnet', () => {
    expect(
      gradeStructure(
        'broken_wing_butterfly',
        input({ magnet: 5800, eodClose: 5808 }),
      ),
    ).toBe(true);
  });
  it('incorrect outside 10pt of magnet', () => {
    expect(
      gradeStructure(
        'broken_wing_butterfly',
        input({ magnet: 5800, eodClose: 5815 }),
      ),
    ).toBe(false);
  });
});

describe('gradeStructure: credit spreads', () => {
  it('credit_call_spread correct when EOD close < ceiling', () => {
    expect(
      gradeStructure(
        'credit_call_spread',
        input({ gammaCeiling: 5820, eodClose: 5810 }),
      ),
    ).toBe(true);
  });
  it('credit_call_spread incorrect when EOD close ≥ ceiling', () => {
    expect(
      gradeStructure(
        'credit_call_spread',
        input({ gammaCeiling: 5820, eodClose: 5825 }),
      ),
    ).toBe(false);
  });
  it('credit_put_spread correct when EOD close > floor', () => {
    expect(
      gradeStructure(
        'credit_put_spread',
        input({ gammaFloor: 5780, eodClose: 5800 }),
      ),
    ).toBe(true);
  });
});

describe('gradeStructure: long_straddle', () => {
  it('correct when |return| ≥ 0.4%', () => {
    expect(
      gradeStructure('long_straddle', input({ eodReturnPct: 0.005 })),
    ).toBe(true);
  });
  it('correct in the opposite direction too (vol expansion)', () => {
    expect(
      gradeStructure('long_straddle', input({ eodReturnPct: -0.006 })),
    ).toBe(true);
  });
  it('incorrect on small move', () => {
    expect(
      gradeStructure('long_straddle', input({ eodReturnPct: 0.002 })),
    ).toBe(false);
  });
});

describe('gradeStructure: unknown', () => {
  it('returns null for an unrecognized structure', () => {
    expect(gradeStructure('made_up_strangle', input())).toBeNull();
  });
});

describe('gradeStructureList', () => {
  it('grades every structure in the list', () => {
    const result = gradeStructureList(
      ['iron_condor', 'long_straddle', 'made_up'],
      input({ icBlownAtEod: false, eodReturnPct: 0.005 }),
    );
    expect(result).toEqual({
      iron_condor: true,
      long_straddle: true,
      made_up: null,
    });
  });

  it('returns an empty map for an empty list', () => {
    expect(gradeStructureList([], input())).toEqual({});
  });
});
