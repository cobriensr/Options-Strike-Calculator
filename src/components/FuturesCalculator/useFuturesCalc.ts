/**
 * Owns the trade-input state (entry/exit/adverse/favorable/contracts) and
 * the derived P&L calculations for FuturesCalculator.
 *
 * Memoization policy: only the calcTrade-based results are memoized
 * (calc / adverseCalc / favorableCalc) because they return fresh objects
 * each call. Simple scalar derivations (bePrice, rrRatio, positionSize)
 * are plain const expressions — manual useMemo on scalars buys nothing
 * and becomes churn once the React Compiler lands.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  breakEvenPrice,
  calcTrade,
  calcTickRow,
  maxContractsFromRisk,
  riskRewardRatio,
  roundTripFees,
  type ContractSpec,
  type Direction,
} from './futures-calc';

const TICK_STEPS = [1, 2, 4, 6, 8, 10, 12, 16, 20] as const;

export type TradeCalc = ReturnType<typeof calcTrade>;
export type TickRow = ReturnType<typeof calcTickRow>;

export interface PositionSize {
  contracts: number;
  riskPerContract: number;
  maxRisk: number;
}

export interface FuturesCalcResult {
  entryInput: string;
  exitInput: string;
  adverseInput: string;
  favorableInput: string;
  contracts: number;
  setEntryInput: (v: string) => void;
  setExitInput: (v: string) => void;
  setAdverseInput: (v: string) => void;
  setFavorableInput: (v: string) => void;
  setContracts: React.Dispatch<React.SetStateAction<number>>;
  clearPrices: () => void;
  handleClear: () => void;
  entry: number;
  exit: number;
  adverse: number;
  favorable: number;
  entryValid: boolean;
  exitValid: boolean;
  contractsValid: boolean;
  adverseValid: boolean;
  favorableValid: boolean;
  calc: TradeCalc | null;
  adverseCalc: TradeCalc | null;
  favorableCalc: TradeCalc | null;
  bePrice: number | null;
  tickLadder: TickRow[] | null;
  rrRatio: number | null;
  positionSize: PositionSize | null;
}

export function useFuturesCalc(
  spec: ContractSpec,
  direction: Direction,
  derivedMaxRisk: number | null,
): FuturesCalcResult {
  const [entryInput, setEntryInput] = useState('');
  const [exitInput, setExitInput] = useState('');
  const [adverseInput, setAdverseInput] = useState('');
  const [favorableInput, setFavorableInput] = useState('');
  const [contracts, setContracts] = useState(1);

  const entry = Number.parseFloat(entryInput);
  const exit = Number.parseFloat(exitInput);
  const adverse = Number.parseFloat(adverseInput);
  const favorable = Number.parseFloat(favorableInput);
  const entryValid = Number.isFinite(entry) && entry > 0;
  const exitValid = Number.isFinite(exit) && exit > 0;
  const adverseValid = Number.isFinite(adverse) && adverse > 0;
  const favorableValid = Number.isFinite(favorable) && favorable > 0;
  const contractsValid = Number.isFinite(contracts) && contracts >= 1;

  const clearPrices = useCallback(() => {
    setEntryInput('');
    setExitInput('');
    setAdverseInput('');
    setFavorableInput('');
  }, []);

  const handleClear = useCallback(() => {
    setEntryInput('');
    setExitInput('');
    setAdverseInput('');
    setFavorableInput('');
    setContracts(1);
  }, []);

  const calc = useMemo<TradeCalc | null>(
    () =>
      entryValid && exitValid && contractsValid
        ? calcTrade(spec, entry, exit, direction, contracts)
        : null,
    [
      entryValid,
      exitValid,
      contractsValid,
      spec,
      entry,
      exit,
      direction,
      contracts,
    ],
  );

  const adverseCalc = useMemo<TradeCalc | null>(
    () =>
      entryValid && adverseValid && contractsValid
        ? calcTrade(spec, entry, adverse, direction, contracts)
        : null,
    [
      entryValid,
      adverseValid,
      contractsValid,
      spec,
      entry,
      adverse,
      direction,
      contracts,
    ],
  );

  const favorableCalc = useMemo<TradeCalc | null>(
    () =>
      entryValid && favorableValid && contractsValid
        ? calcTrade(spec, entry, favorable, direction, contracts)
        : null,
    [
      entryValid,
      favorableValid,
      contractsValid,
      spec,
      entry,
      favorable,
      direction,
      contracts,
    ],
  );

  // Scalar derivations — not memoized
  const bePrice =
    entryValid && contractsValid
      ? breakEvenPrice(spec, entry, direction, contracts)
      : null;

  const rrRatio =
    entryValid && exitValid && adverseValid
      ? riskRewardRatio(entry, exit, adverse, direction)
      : null;

  // Tick ladder — memoized because the map produces 9 fresh objects
  const tickLadder = useMemo<TickRow[] | null>(
    () =>
      entryValid && contractsValid
        ? TICK_STEPS.map((t) =>
            calcTickRow(spec, entry, direction, contracts, t),
          )
        : null,
    [entryValid, contractsValid, spec, entry, direction, contracts],
  );

  // Position sizing — builds an object, kept as useMemo for identity stability
  const positionSize = useMemo<PositionSize | null>(() => {
    if (!entryValid || !adverseValid || derivedMaxRisk === null) return null;
    const stopPts = direction === 'long' ? entry - adverse : adverse - entry;
    if (stopPts <= 0) return null;
    return {
      contracts: maxContractsFromRisk(
        spec,
        entry,
        adverse,
        direction,
        derivedMaxRisk,
      ),
      riskPerContract: stopPts * spec.pointValue + roundTripFees(spec, 1),
      maxRisk: derivedMaxRisk,
    };
  }, [
    entryValid,
    adverseValid,
    derivedMaxRisk,
    spec,
    entry,
    adverse,
    direction,
  ]);

  return {
    entryInput,
    exitInput,
    adverseInput,
    favorableInput,
    contracts,
    setEntryInput,
    setExitInput,
    setAdverseInput,
    setFavorableInput,
    setContracts,
    clearPrices,
    handleClear,
    entry,
    exit,
    adverse,
    favorable,
    entryValid,
    exitValid,
    contractsValid,
    adverseValid,
    favorableValid,
    calc,
    adverseCalc,
    favorableCalc,
    bePrice,
    tickLadder,
    rrRatio,
    positionSize,
  };
}
