/**
 * useClusterMultiplier — today's volatility-clustering multiplier, computed
 * where the app owns it instead of inside the Volatility Clustering panel.
 *
 * The panel sits in the Market Regime card, which App renders collapsed, so
 * the multiplier its effect used to report was missing on every page load
 * and the app used and saved the default 1 (F24, docs/superpowers/specs/
 * live-data-integrity-2026-11-06.md). Here the value is a plain function of
 * the VIX, spot and yesterday's open/high/low, derived during render: it is
 * right on the first render that has its inputs, with the card open or closed
 * and on live or past dates. Nothing is mirrored into state.
 *
 * The one piece of state is the owner's manual edit of yesterday's range. It
 * overrides the computed value while it is held. It belongs to a `scope` (App
 * passes the selected date): an edit made under another scope is ignored, so
 * a typed range never leaks onto another day. It lives as long as this hook,
 * not the panel, so closing the card keeps the multiplier the owner set.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  computeClusterSignal,
  type ClusterSignal,
} from '../utils/volatility-cluster';

export type ClusterField = 'open' | 'high' | 'low';

/** Yesterday's open, high and low as the panel's text fields show them. */
export type ClusterInputs = Readonly<Record<ClusterField, string>>;

export interface YesterdayOHLC {
  readonly open: number;
  readonly high: number;
  readonly low: number;
}

interface Args {
  readonly vix: number | null | undefined;
  readonly spot: number | null | undefined;
  /** From the history snapshot or the live feed; null until it arrives. */
  readonly yesterday: YesterdayOHLC | null | undefined;
  /** What an edit belongs to. App passes the selected date. */
  readonly scope: string;
}

export interface ClusterMultiplier {
  /** The effective result: the owner's edit if one is held, else yesterday's data. */
  readonly signal: ClusterSignal;
  /** The three fields as shown: the edit if one is held, else yesterday. */
  readonly inputs: ClusterInputs;
  readonly setInput: (field: ClusterField, value: string) => void;
}

interface ScopedEdit {
  readonly scope: string;
  readonly inputs: ClusterInputs;
}

function show(value: number | undefined): string {
  return value != null && Number.isFinite(value) ? value.toFixed(2) : '';
}

function parse(value: string): number {
  return Number.parseFloat(value);
}

export function useClusterMultiplier({
  vix,
  spot,
  yesterday,
  scope,
}: Args): ClusterMultiplier {
  const [edit, setEdit] = useState<ScopedEdit | null>(null);
  const yOpen = yesterday?.open;
  const yHigh = yesterday?.high;
  const yLow = yesterday?.low;

  const dataInputs = useMemo<ClusterInputs>(
    () => ({ open: show(yOpen), high: show(yHigh), low: show(yLow) }),
    [yOpen, yHigh, yLow],
  );
  const editedInputs = edit?.scope === scope ? edit.inputs : null;
  const inputs = editedInputs ?? dataInputs;

  const signal = useMemo(
    () =>
      editedInputs
        ? computeClusterSignal({
            vix,
            spot,
            open: parse(editedInputs.open),
            high: parse(editedInputs.high),
            low: parse(editedInputs.low),
          })
        : computeClusterSignal({
            vix,
            spot,
            open: yOpen,
            high: yHigh,
            low: yLow,
          }),
    [vix, spot, editedInputs, yOpen, yHigh, yLow],
  );

  const setInput = useCallback(
    (field: ClusterField, value: string) => {
      setEdit((prev) => ({
        scope,
        inputs: {
          ...(prev?.scope === scope ? prev.inputs : dataInputs),
          [field]: value,
        },
      }));
    },
    [scope, dataInputs],
  );

  return useMemo(
    () => ({ signal, inputs, setInput }),
    [signal, inputs, setInput],
  );
}
