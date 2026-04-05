import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRiskCalculator } from '../hooks/useRiskCalculator';

// ============================================================
// TESTS
// ============================================================

describe('useRiskCalculator', () => {
  // ── Default State ───────────────────────────────────────

  it('default mode is sell', () => {
    const { result } = renderHook(() => useRiskCalculator());
    expect(result.current.mode).toBe('sell');
  });

  it('default wing is 10', () => {
    const { result } = renderHook(() => useRiskCalculator());
    expect(result.current.wing).toBe(10);
  });

  it('default contracts is 1', () => {
    const { result } = renderHook(() => useRiskCalculator());
    expect(result.current.contracts).toBe(1);
  });

  it('default stopMultiple is null (no stop)', () => {
    const { result } = renderHook(() => useRiskCalculator());
    expect(result.current.stopMultiple).toBeNull();
  });

  it('default portfolioCap is 100', () => {
    const { result } = renderHook(() => useRiskCalculator());
    expect(result.current.portfolioCap).toBe(100);
  });

  // ── Balance Updates ─────────────────────────────────────

  it('setting balance updates derived calculations', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setBalance('50000');
      result.current.setCreditInput('1.50');
    });

    expect(result.current.bal).toBe(50000);
    expect(result.current.credit).toBe(1.5);
    expect(result.current.lossPct).toBeGreaterThan(0);
  });

  // ── Sell-Side Core Calculations ─────────────────────────

  it('credit per contract = credit * 100', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.50');
    });

    expect(result.current.creditPerContract).toBeCloseTo(250, 6);
  });

  it('gross loss per contract = wing * 100', () => {
    const { result } = renderHook(() => useRiskCalculator());
    // Default wing = 10
    expect(result.current.grossLossPerContract).toBe(1000);
  });

  it('gross loss updates when wing changes', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setWing(20);
    });

    expect(result.current.grossLossPerContract).toBe(2000);
  });

  it('net loss per contract = gross - credit (when credit > 0)', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('1.50');
    });

    // wing=10 → gross=1000, credit=150 → net=850
    expect(result.current.netLossPerContract).toBeCloseTo(850, 6);
  });

  it('net loss per contract is floored at 0', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      // Credit > wing (unrealistic but tests the floor)
      result.current.setCreditInput('15.00');
    });

    // wing=10 → gross=1000, credit=1500 → net = max(0, -500) = 0
    expect(result.current.netLossPerContract).toBe(0);
  });

  // ── Stop Loss (Sell Mode) ───────────────────────────────

  it('stop loss calculation: (stopMultiple - 1) * creditPerContract', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      result.current.setStopMultiple(3);
    });

    // credit=200, stop = (3-1) * 200 = 400
    expect(result.current.hasStop).toBe(true);
    expect(result.current.stopLossPerContract).toBeCloseTo(400, 6);
  });

  it('with stop, loss is min(stopLoss, netLoss)', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      result.current.setStopMultiple(3);
    });

    // credit=200, stop=(3-1)*200=400, net=1000-200=800
    // loss = min(400, 800) = 400
    expect(result.current.lossPerContract).toBeCloseTo(400, 6);
  });

  it('without stop and with credit, loss = netLoss', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      // stopMultiple defaults to null
    });

    // net = 1000 - 200 = 800
    expect(result.current.hasStop).toBe(false);
    expect(result.current.lossPerContract).toBeCloseTo(800, 6);
  });

  it('without stop and without credit, loss = grossLoss', () => {
    const { result } = renderHook(() => useRiskCalculator());
    // No credit set, no stop

    expect(result.current.hasCredit).toBe(false);
    expect(result.current.lossPerContract).toBe(1000);
  });

  it('stop loss is 0 when stopMultiple is null', () => {
    const { result } = renderHook(() => useRiskCalculator());
    expect(result.current.stopLossPerContract).toBe(0);
  });

  // ── Total Loss & Loss Percentage ────────────────────────

  it('total loss = lossPerContract * contracts', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      result.current.setContracts(3);
    });

    // loss per contract = 800, total = 800 * 3 = 2400
    expect(result.current.totalLoss).toBeCloseTo(2400, 6);
  });

  it('loss percentage = totalLoss / balance * 100', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setBalance('50000');
      result.current.setCreditInput('2.00');
      result.current.setContracts(1);
    });

    // loss=800, pct = 800/50000 * 100 = 1.6%
    expect(result.current.lossPct).toBeCloseTo(1.6, 4);
  });

  it('loss percentage is 0 when balance is 0', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setBalance('');
      result.current.setCreditInput('2.00');
    });

    expect(result.current.lossPct).toBe(0);
  });

  // ── Max Positions ───────────────────────────────────────

  it('max positions = portfolioCap / lossPct', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setBalance('50000');
      result.current.setCreditInput('2.00');
      result.current.setContracts(1);
      result.current.setPortfolioCap(100);
    });

    // lossPct = 1.6%, maxPositions = floor(100/1.6) = 62
    expect(result.current.maxPositions).toBe(
      Math.floor(100 / result.current.lossPct),
    );
  });

  it('max positions is 0 when lossPct is 0', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setBalance('0');
    });

    expect(result.current.maxPositions).toBe(0);
  });

  // ── Risk/Reward Ratio ───────────────────────────────────

  it('risk/reward ratio = lossPerContract / maxProfit in sell mode', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
    });

    // maxProfit = creditPerContract = 200
    // lossPerContract = 800
    // rrRatio = 800/200 = 4
    expect(result.current.maxProfit).toBeCloseTo(200, 6);
    expect(result.current.rrRatio).toBeCloseTo(4, 4);
  });

  it('risk/reward ratio is 0 when maxProfit is 0', () => {
    const { result } = renderHook(() => useRiskCalculator());
    // No credit set
    expect(result.current.rrRatio).toBe(0);
  });

  // ── Credit Percentage ───────────────────────────────────

  it('creditPct = credit / wing', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
    });

    // credit=2, wing=10 → 2/10 = 0.2
    expect(result.current.creditPct).toBeCloseTo(0.2, 6);
  });

  it('creditPct is 0 when wing is 0', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setWing(0);
      result.current.setCreditInput('2.00');
    });

    expect(result.current.creditPct).toBe(0);
  });

  // ── Buy Mode ────────────────────────────────────────────

  it('buy mode: loss = premium * 100 when no stop', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setMode('buy');
      result.current.setPremiumInput('5.00');
    });

    // premium=5, premiumPerContract=500, no stop → loss=500
    expect(result.current.premiumPerContract).toBeCloseTo(500, 6);
    expect(result.current.lossPerContract).toBeCloseTo(500, 6);
  });

  it('buy mode with stop: loss = premium * stopPct/100', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setMode('buy');
      result.current.setPremiumInput('5.00');
      result.current.setBuyStopPct(50);
    });

    // premium=5, premiumPerContract=500, stopPct=50
    // buyStopLossPerContract = 500 * (50/100) = 250
    expect(result.current.hasBuyStop).toBe(true);
    expect(result.current.buyStopLossPerContract).toBeCloseTo(250, 6);
    expect(result.current.lossPerContract).toBeCloseTo(250, 6);
  });

  it('buy mode: no stop when buyStopPct is null', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setMode('buy');
      result.current.setPremiumInput('5.00');
    });

    expect(result.current.hasBuyStop).toBe(false);
    // Loss should be full premium
    expect(result.current.lossPerContract).toBeCloseTo(500, 6);
  });

  it('buy mode: target exit profit calculation', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setMode('buy');
      result.current.setPremiumInput('3.00');
      result.current.setTargetExitInput('8.00');
    });

    // profit = (8 - 3) * 100 = 500
    expect(result.current.hasTarget).toBe(true);
    expect(result.current.buyProfitPerContract).toBeCloseTo(500, 6);
    expect(result.current.maxProfit).toBeCloseTo(500, 6);
  });

  it('buy mode: no target when targetExit <= premium', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setMode('buy');
      result.current.setPremiumInput('5.00');
      result.current.setTargetExitInput('4.00');
    });

    expect(result.current.hasTarget).toBe(false);
    expect(result.current.buyProfitPerContract).toBe(0);
  });

  // ── EV Calculation ──────────────────────────────────────

  it('EV calculation with POP (expected value per contract)', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      result.current.setPopInput('85');
    });

    // maxProfit = 200, lossPerContract = 800
    // EV = (85/100)*200 - (15/100)*800 = 170 - 120 = 50
    expect(result.current.hasPop).toBe(true);
    expect(result.current.evPerContract).toBeCloseTo(50, 4);
  });

  it('EV is 0 when POP is 0', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      result.current.setPopInput('0');
    });

    expect(result.current.hasPop).toBe(false);
    expect(result.current.evPerContract).toBe(0);
  });

  it('EV is 0 when POP is 100 (not valid probability)', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      result.current.setPopInput('100');
    });

    expect(result.current.hasPop).toBe(false);
    expect(result.current.evPerContract).toBe(0);
  });

  it('negative EV when POP is low', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      result.current.setPopInput('20');
    });

    // EV = (20/100)*200 - (80/100)*800 = 40 - 640 = -600
    expect(result.current.evPerContract).toBeCloseTo(-600, 4);
  });

  // ── Mode Switching ──────────────────────────────────────

  it('switching mode from sell to buy', () => {
    const { result } = renderHook(() => useRiskCalculator());

    expect(result.current.mode).toBe('sell');

    act(() => {
      result.current.setMode('buy');
    });

    expect(result.current.mode).toBe('buy');
  });

  it('mode affects which loss calculation is used', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      result.current.setPremiumInput('5.00');
    });

    // In sell mode, loss uses credit spread math
    expect(result.current.mode).toBe('sell');
    expect(result.current.lossPerContract).toBeCloseTo(800, 6);

    act(() => {
      result.current.setMode('buy');
    });

    // In buy mode, loss uses premium
    expect(result.current.mode).toBe('buy');
    expect(result.current.lossPerContract).toBeCloseTo(500, 6);
  });

  // ── Buying Power ────────────────────────────────────────

  it('buying power in sell mode = netLossPerContract', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
    });

    // net = 1000 - 200 = 800
    expect(result.current.bpPerContract).toBeCloseTo(800, 6);
  });

  it('buying power in buy mode = premiumPerContract', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setMode('buy');
      result.current.setPremiumInput('5.00');
    });

    expect(result.current.bpPerContract).toBeCloseTo(500, 6);
  });

  it('total buying power = bpPerContract * contracts', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('2.00');
      result.current.setContracts(5);
    });

    // bp = 800, total = 800 * 5 = 4000
    expect(result.current.totalBp).toBeCloseTo(4000, 6);
  });

  // ── Edge Cases ──────────────────────────────────────────

  it('handles zero credit gracefully', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setCreditInput('0');
    });

    expect(result.current.credit).toBe(0);
    expect(result.current.hasCredit).toBe(false);
    expect(result.current.creditPerContract).toBe(0);
    expect(result.current.lossPerContract).toBe(1000); // grossLoss
  });

  it('handles empty inputs gracefully (defaults to 0)', () => {
    const { result } = renderHook(() => useRiskCalculator());

    expect(result.current.credit).toBe(0);
    expect(result.current.premium).toBe(0);
    expect(result.current.delta).toBe(0);
    expect(result.current.pop).toBe(0);
    expect(result.current.bal).toBe(0);
  });

  it('stop in sell mode does not apply in buy mode', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setStopMultiple(3);
      result.current.setCreditInput('2.00');
      result.current.setMode('buy');
      result.current.setPremiumInput('5.00');
    });

    // hasStop requires mode=sell, so should be false in buy mode
    expect(result.current.hasStop).toBe(false);
    // loss should use buy-mode calculation
    expect(result.current.lossPerContract).toBeCloseTo(500, 6);
  });

  it('buy mode risk/reward with target exit', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setMode('buy');
      result.current.setPremiumInput('2.00');
      result.current.setTargetExitInput('6.00');
    });

    // maxProfit = (6-2)*100 = 400
    // lossPerContract = 200
    // rrRatio = 200/400 = 0.5
    expect(result.current.maxProfit).toBeCloseTo(400, 6);
    expect(result.current.rrRatio).toBeCloseTo(0.5, 4);
  });

  it('EV in buy mode with POP and target', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setMode('buy');
      result.current.setPremiumInput('2.00');
      result.current.setTargetExitInput('6.00');
      result.current.setPopInput('60');
    });

    // maxProfit = 400, lossPerContract = 200
    // EV = (60/100)*400 - (40/100)*200 = 240 - 80 = 160
    expect(result.current.evPerContract).toBeCloseTo(160, 4);
  });

  it('delta value parses from input', () => {
    const { result } = renderHook(() => useRiskCalculator());

    act(() => {
      result.current.setDeltaInput('0.10');
    });

    expect(result.current.delta).toBeCloseTo(0.1, 6);
    expect(result.current.hasDelta).toBe(true);
  });

  it('hasDelta is false when delta is 0', () => {
    const { result } = renderHook(() => useRiskCalculator());
    expect(result.current.hasDelta).toBe(false);
  });
});
