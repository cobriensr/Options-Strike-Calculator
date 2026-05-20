/**
 * useMLInsights — Fetches ML pipeline plot data and findings.
 *
 * Calls GET /api/ml/plots on mount.
 * No polling (data changes once nightly) but exposes a manual refresh.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getErrorMessage } from '../utils/error';

export interface PlotAnalysis {
  what_it_means: string;
  how_to_apply: string;
  watch_out_for: string;
}

export interface MLPlot {
  name: string;
  imageUrl: string;
  analysis: PlotAnalysis | null;
  model: string;
  pipelineDate: string;
  updatedAt: string;
}

export interface MLPlotsResponse {
  plots: MLPlot[];
  findings: Record<string, unknown> | null;
  pipelineDate: string | null;
}

export interface MLInsightsState {
  plots: MLPlot[];
  findings: Record<string, unknown> | null;
  pipelineDate: string | null;
  loading: boolean;
  error: string | null;
  /**
   * Epoch milliseconds when the hook last successfully fetched plot data.
   * Set via `Date.now()` after a 2xx response and reset to `null` on every
   * new in-flight fetch (so spinners can show "Refreshing…" without
   * stale freshness leaking through). The per-plot `MLPlot.updatedAt`
   * payload field is independent — it carries the pipeline run time
   * embedded in each image record, not the hook's HTTP freshness.
   */
  fetchedAt: number | null;
  refresh: () => Promise<void>;
}

export function useMLInsights(): MLInsightsState {
  const [plots, setPlots] = useState<MLPlot[]>([]);
  const [findings, setFindings] = useState<Record<string, unknown> | null>(
    null,
  );
  const [pipelineDate, setPipelineDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/ml/plots', {
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch ML plots (HTTP ${res.status})`);
      }

      const data: MLPlotsResponse = await res.json();
      setPlots(data.plots ?? []);
      setFindings(data.findings ?? null);
      setPipelineDate(data.pipelineDate ?? null);
      // Stamp the wall clock only after a successful 2xx + parse so that
      // an error path doesn't make the panel look like it just refreshed.
      setFetchedAt(Date.now());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchData]);

  return {
    plots,
    findings,
    pipelineDate,
    loading,
    error,
    fetchedAt,
    refresh: fetchData,
  };
}
