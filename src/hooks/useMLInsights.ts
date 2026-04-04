/**
 * useMLInsights — Fetches ML pipeline plot data and findings.
 *
 * Calls GET /api/ml/plots on mount.
 * No polling (data changes once nightly) but exposes a manual refetch.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export interface PlotAnalysis {
  visualization: string;
  data_inputs: string;
  interpretation: string;
  implications: string;
  caveats: string;
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
  refetch: () => void;
}

export function useMLInsights(): MLInsightsState {
  const [plots, setPlots] = useState<MLPlot[]>([]);
  const [findings, setFindings] = useState<Record<string, unknown> | null>(
    null,
  );
  const [pipelineDate, setPipelineDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(
        err instanceof Error ? err.message : 'Failed to fetch ML insights',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchData]);

  return { plots, findings, pipelineDate, loading, error, refetch: fetchData };
}
