/**
 * useAnalysisContext — Builds the AnalysisContext object sent to the
 * /api/analyze endpoint.
 *
 * Extracted from the App.tsx useMemo block to reduce component size.
 * Pure computation — no side effects, no API calls.
 */

import { useMemo } from 'react';
import { getTopOIStrikes } from '../utils/pin-risk';
import type { AnalysisContext } from '../components/ChartAnalysis';
import type { CalculationResults } from '../types';
import type { ComputedSignals } from './useComputedSignals';
import type { ChainResponse, EventItem } from '../types/api';
import type { HistorySnapshot } from './useHistoryData';
export interface UseAnalysisContextParams {
  selectedDate: string;
  timeHour: string;
  timeMinute: string;
  timeAmPm: string;
  timezone: string;
  results: CalculationResults | null;
  dSpot: string;
  dVix: string;
  signals: ComputedSignals;
  clusterMult: number;
  historySnapshot: HistorySnapshot | null;
  events: readonly EventItem[] | undefined;
  chain: ChainResponse | null;
}

export function useAnalysisContext({
  selectedDate,
  timeHour,
  timeMinute,
  timeAmPm,
  timezone,
  results,
  dSpot,
  dVix,
  signals,
  clusterMult,
  historySnapshot,
  events,
  chain,
}: UseAnalysisContextParams): AnalysisContext {
  return useMemo(
    () =>
      ({
        selectedDate,
        entryTime: `${timeHour}:${timeMinute} ${timeAmPm} ${timezone}`,
        spx: results?.spot,
        spy: Number.parseFloat(dSpot) || undefined,
        vix: Number.parseFloat(dVix) || undefined,
        vix1d: signals.vix1d,
        vix9d: signals.vix9d,
        vvix: signals.vvix,
        sigma: results?.sigma,
        sigmaSource: signals.sigmaSource,
        T: results?.T,
        hoursRemaining: results?.hoursRemaining,
        deltaCeiling: signals.icCeiling ?? undefined,
        putSpreadCeiling: signals.putSpreadCeiling ?? undefined,
        callSpreadCeiling: signals.callSpreadCeiling ?? undefined,
        regimeZone: signals.regimeZone ?? undefined,
        clusterMult,
        dowLabel: signals.dowLabel ?? undefined,
        openingRangeSignal: signals.openingRangeSignal ?? undefined,
        openingRangeAvailable: signals.openingRangeAvailable,
        openingRangeHigh: signals.openingRangeHigh ?? undefined,
        openingRangeLow: signals.openingRangeLow ?? undefined,
        openingRangePctConsumed: signals.openingRangePctConsumed ?? undefined,
        vixTermSignal: signals.vixTermSignal ?? undefined,
        vixTermShape: signals.vixTermShape ?? undefined,
        clusterPutMult: signals.clusterPutMult ?? undefined,
        clusterCallMult: signals.clusterCallMult ?? undefined,
        rvIvRatio:
          signals.rvIvRatio == null
            ? undefined
            : `${signals.rvIvRatio.toFixed(2)} (${signals.rvIvLabel})`,
        rvAnnualized: signals.rvAnnualized ?? undefined,
        ivAccelMult: (() => {
          const row = results?.allDeltas.find((r) => !('error' in r));
          return row && !('error' in row) ? row.ivAccelMult : undefined;
        })(),
        prevClose: signals.prevClose ?? undefined,
        overnightGap:
          signals.overnightGap == null
            ? undefined
            : String(signals.overnightGap),
        isBacktest: !!historySnapshot,
        dataNote: signals.dataNote,
        events: (events ?? [])
          .filter(
            (e) =>
              (e.severity === 'high' || e.severity === 'medium') &&
              e.date === selectedDate,
          )
          .map((e) => ({
            event: e.event,
            time: e.time,
            severity: e.severity,
          })),
        topOIStrikes:
          chain?.puts && chain?.calls && results?.spot
            ? getTopOIStrikes(chain.puts, chain.calls, results.spot, 5)
            : undefined,
        skewMetrics: (() => {
          if (!chain?.puts?.length || !chain?.calls?.length) return undefined;
          // Find ~25-delta put and call, plus ATM
          const put25 = chain.puts.reduce((best, p) =>
            Math.abs(Math.abs(p.delta) - 0.25) <
            Math.abs(Math.abs(best.delta) - 0.25)
              ? p
              : best,
          );
          const call25 = chain.calls.reduce((best, c) =>
            Math.abs(c.delta - 0.25) < Math.abs(best.delta - 0.25) ? c : best,
          );
          const atm = chain.calls.reduce((best, c) =>
            Math.abs(c.delta - 0.5) < Math.abs(best.delta - 0.5) ? c : best,
          );
          if (!put25.iv || !call25.iv || !atm.iv) return undefined;
          const atmIV = atm.iv * 100;
          const put25dIV = put25.iv * 100;
          const call25dIV = call25.iv * 100;
          const putSkew25d = Math.round((put25dIV - atmIV) * 100) / 100;
          const callSkew25d = Math.round((call25dIV - atmIV) * 100) / 100;
          const skewRatio =
            callSkew25d !== 0
              ? Math.round(
                  (Math.abs(putSkew25d) / Math.abs(callSkew25d)) * 100,
                ) / 100
              : 0;
          return {
            put25dIV: Math.round(put25dIV * 100) / 100,
            call25dIV: Math.round(call25dIV * 100) / 100,
            atmIV: Math.round(atmIV * 100) / 100,
            putSkew25d,
            callSkew25d,
            skewRatio,
          };
        })(),
      }) satisfies AnalysisContext,
    [
      selectedDate,
      timeHour,
      timeMinute,
      timeAmPm,
      timezone,
      results,
      dSpot,
      dVix,
      signals,
      clusterMult,
      historySnapshot,
      events,
      chain,
    ],
  );
}
