/**
 * ExportCSVButton — downloads two CSV files (chains + legs) for offline
 * analysis.
 *
 * CSV generation, column ordering, and the blob/download plumbing live in
 * `./pyramid-csv` so this file only exports a component (keeps
 * react-refresh happy) and the helpers stay unit-testable in isolation.
 *
 * Null cells export as empty strings so pandas reads them as NaN. Raw
 * columns only — no derived fields. Derivation happens downstream in the
 * analysis notebook.
 *
 * The button owns the leg fetch loop itself: calls `fetchAllLegs` on click,
 * serialises both CSVs in memory, then dispatches two anchor-based
 * downloads with today's ISO date as the filename suffix.
 */

import { useCallback, useState } from 'react';
import type { PyramidChain, PyramidLeg } from '../../types/pyramid';
import { getErrorMessage } from '../../utils/error';
import {
  CHAIN_COLUMNS,
  LEG_COLUMNS,
  buildCsv,
  downloadCsv,
  todayForFilename,
} from './pyramid-csv';

export interface ExportCSVButtonProps {
  readonly chains: ReadonlyArray<PyramidChain>;
  readonly fetchAllLegs: () => Promise<ReadonlyArray<PyramidLeg>>;
}

export default function ExportCSVButton({
  chains,
  fetchAllLegs,
}: ExportCSVButtonProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const legs = await fetchAllLegs();
      const stamp = todayForFilename();
      const chainsCsv = buildCsv<PyramidChain>(
        CHAIN_COLUMNS,
        chains as ReadonlyArray<PyramidChain>,
      );
      const legsCsv = buildCsv<PyramidLeg>(
        LEG_COLUMNS,
        legs as ReadonlyArray<PyramidLeg>,
      );
      downloadCsv(`pyramid_chains_${stamp}.csv`, chainsCsv);
      downloadCsv(`pyramid_legs_${stamp}.csv`, legsCsv);
    } catch (e) {
      setErr(`Export failed: ${getErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, chains, fetchAllLegs]);

  const disabled = busy || chains.length === 0;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => {
          void handleExport();
        }}
        disabled={disabled}
        aria-label="Export pyramid chains and legs as CSV files"
        className="border-edge-strong bg-chip-bg text-primary hover:bg-surface-alt cursor-pointer rounded-md border-[1.5px] px-3 py-1.5 font-sans text-xs font-semibold tracking-wider uppercase disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Exporting\u2026' : 'Export CSV'}
      </button>
      {err != null && (
        <span role="alert" className="text-danger font-sans text-[10px]">
          {err}
        </span>
      )}
    </div>
  );
}
