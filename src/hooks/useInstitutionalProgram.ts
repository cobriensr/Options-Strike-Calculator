import { useEffect, useState } from 'react';

export interface DominantPair {
  low_strike: number;
  high_strike: number;
  spread_width: number;
  total_size: number;
  total_premium: number;
  direction: 'sell' | 'buy' | 'mixed';
}

export interface DailyProgramSummary {
  date: string;
  dominant_pair: DominantPair | null;
  avg_spot: number | null;
  ceiling_pct_above_spot: number | null;
  n_blocks: number;
  n_call_blocks: number;
  n_put_blocks: number;
}

export interface InstitutionalBlock {
  executed_at: string;
  option_chain_id: string;
  strike: number;
  option_type: 'call' | 'put';
  dte: number;
  size: number;
  premium: number;
  price: number;
  side: string | null;
  condition: string;
  exchange: string | null;
  underlying_price: number;
  moneyness_pct: number;
  program_track: 'ceiling' | 'opening_atm' | 'other';
}

interface InstitutionalProgramData {
  days: DailyProgramSummary[];
  today: { blocks: InstitutionalBlock[] };
}

export interface StrikeCell {
  strike: number;
  option_type: 'call' | 'put';
  n_blocks: number;
  total_contracts: number;
  total_premium: number;
  last_seen_date: string;
  active_days: number;
  latest_expiry: string;
}

export interface StrikeHeatmapData {
  spot: number | null;
  days: number;
  track: 'ceiling' | 'opening_atm';
  rows: StrikeCell[];
}

export function useInstitutionalProgram(days = 60) {
  const [data, setData] = useState<InstitutionalProgramData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/institutional-program?days=${days}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (!cancelled) {
          setData(json as InstitutionalProgramData);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e as Error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  return { data, loading, error };
}

export function useStrikeHeatmap(
  track: 'ceiling' | 'opening_atm' = 'ceiling',
  days = 60,
) {
  const [data, setData] = useState<StrikeHeatmapData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/institutional-program/strike-heatmap?days=${days}&track=${track}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => {
        if (!cancelled) setData(json as StrikeHeatmapData);
      })
      .catch(() => {
        /* surface via data === null; component renders empty state */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [track, days]);

  return { data, loading };
}
