/**
 * DealerRegimeTile — 4-cell row showing the dealer-gamma regime at spot
 * for SPX, NDX, SPY, QQQ. Sits above the Strike Battle Map as the
 * primary "is the market dampening or amplifying?" read.
 *
 * Each cell maps a `zero_gamma_levels` row through the pure classifier
 * to one of: `long-γ`, `short-γ`, `transition`, `uncertain`. Polling
 * cadence + auth tier + auth fall-through follow the sibling Strike
 * Battle Map / Greek Flow patterns.
 *
 * Spec: docs/superpowers/specs/dealer-regime-tile-2026-05-03.md
 */

import { memo, useMemo } from 'react';
import {
  useDealerRegime,
  type DealerRegimeRow,
} from '../../hooks/useDealerRegime';
import { SectionBox } from '../ui';
import { classify, type DealerRegimeState } from './classify';
import { Cell } from './Cell';

const TICKERS = ['SPX', 'NDX', 'SPY', 'QQQ'] as const;
type Ticker = (typeof TICKERS)[number];

interface DealerRegimeTileProps {
  marketOpen: boolean;
}

interface ClassifiedCell {
  ticker: Ticker;
  row: DealerRegimeRow | null;
  state: DealerRegimeState;
}

function DealerRegimeTileInner({ marketOpen }: DealerRegimeTileProps) {
  const { data, loading, error } = useDealerRegime(marketOpen);

  const cells = useMemo<ClassifiedCell[]>(() => {
    const byTicker = new Map<Ticker, DealerRegimeRow>();
    for (const r of data?.rows ?? []) {
      byTicker.set(r.ticker, r);
    }
    return TICKERS.map((ticker) => {
      const row = byTicker.get(ticker) ?? null;
      const state: DealerRegimeState = row
        ? classify({
            spot: row.spot,
            zeroGamma: row.zeroGamma,
            confidence: row.confidence,
            netGammaAtSpot: row.netGammaAtSpot,
            ts: row.ts,
          })
        : 'uncertain';
      return { ticker, row, state };
    });
  }, [data]);

  return (
    <SectionBox label="Dealer Regime" collapsible>
      <p className="text-secondary mb-3 font-sans text-xs">
        Dealer-gamma regime at spot for SPX, NDX, SPY, QQQ. <span className="text-sky-300">Long γ</span>{' '}
        = dampening (mean-reverting), <span className="text-amber-300">short γ</span>{' '}
        = amplifying (acceleration-prone), <span className="text-zinc-300">transition</span>{' '}
        = spot near zero-gamma boundary,{' '}
        <span className="text-zinc-500">uncertain</span> = low confidence or
        stale data. Polls every 30s during market hours.
      </p>
      <Body cells={cells} loading={loading} error={error} hasData={data != null} />
    </SectionBox>
  );
}

interface BodyProps {
  cells: ClassifiedCell[];
  loading: boolean;
  error: string | null;
  hasData: boolean;
}

function Body({ cells, loading, error, hasData }: BodyProps) {
  if (error && !hasData) {
    return (
      <div role="alert" className="text-secondary font-sans text-xs">
        {error}
      </div>
    );
  }
  if (loading && !hasData) {
    return <div className="text-secondary font-sans text-xs">Loading…</div>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((c) => (
        <Cell key={c.ticker} ticker={c.ticker} row={c.row} state={c.state} />
      ))}
    </div>
  );
}

export const DealerRegimeTile = memo(DealerRegimeTileInner);
