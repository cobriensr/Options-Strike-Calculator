/**
 * GexbotSection — dedicated section housing the GEXBot trial-data
 * components. Spec:
 * docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 *
 * Children consume their own data via useGexbotData. The section
 * itself is a layout container that forwards `marketOpen` (used
 * for polling gating) and the live SPX spot (used by StrikeMoverLadder
 * to anchor the ladder). After the close it also labels the whole section
 * CLOSED with the snapshots' capture time, and hands the ladder that time
 * and the snapshots' SPX spot (see StrikeMoverLadder).
 *
 * LevelLadder sits under the two tiles, above StrikeMoverLadder. It takes
 * the spot too, plus the calculator's strike rows (its candidate short
 * strikes) and the quotes' fetch time and session (so a quote that has
 * stopped updating gives way to GEXBot's own spot).
 *
 * The Sibling-Asset Confirmation Bar lives inline in lottery/silent-
 * boom rows, not in this section.
 */

import { memo } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import type { MarketSession } from '../../hooks/useMarketData';
import type { DeltaRow, DeltaRowError } from '../../types';
import { ClosedBadge, SectionBox } from '../ui';
import { CharmClock } from './CharmClock';
import { ConvexityMatrix } from './ConvexityMatrix';
import { DealerStateSummaryStrip } from './DealerStateSummaryStrip';
import { DexoflowVelocityTape } from './DexoflowVelocityTape';
import { ExpectedMoveTile } from './ExpectedMoveTile';
import { GammaCompass } from './GammaCompass';
import { LevelLadder } from './LevelLadder';
import { NetVannaTile } from './NetVannaTile';
import { StrikeMoverLadder } from './StrikeMoverLadder';

interface GexbotSectionProps {
  marketOpen: boolean;
  /**
   * Live SPX spot (Schwab via useMarketData). Forwarded to
   * StrikeMoverLadder and LevelLadder; other children don't use it.
   */
  spxSpot: number | null;
  /**
   * The calculator's strike rows, for LevelLadder's candidate short strikes.
   * Null with no calculation, and in backtest mode (the calculator then
   * describes a past moment while the levels are live).
   */
  allDeltas: ReadonlyArray<DeltaRow | DeltaRowError> | null;
  /** Epoch ms of the last successful quotes fetch; LevelLadder's spot rule. */
  quotesFetchedAt: number | null;
  /** Current US equity session; LevelLadder's spot rule. */
  session: MarketSession;
}

const SNAPSHOTS_SPEC = { view: 'snapshots-latest' as const };

function GexbotSectionInner({
  marketOpen,
  spxSpot,
  allDeltas,
  quotesFetchedAt,
  session,
}: GexbotSectionProps) {
  // The snapshots read the children already make (deduped by URL), for the
  // header label and the ladder's closed-session inputs.
  const { rows, asOf } = useGexbotData(SNAPSHOTS_SPEC, marketOpen);
  const fallbackSpot = rows.find((r) => r.ticker === 'SPX')?.spot ?? null;
  return (
    <SectionBox
      label="GEXBot Taker Flow"
      collapsible
      headerRight={
        marketOpen ? undefined : (
          <ClosedBadge asOf={asOf} testId="gexbot-closed-label" />
        )
      }
    >
      <div className="flex flex-col gap-3">
        <DealerStateSummaryStrip marketOpen={marketOpen} />
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <ExpectedMoveTile marketOpen={marketOpen} />
          <NetVannaTile marketOpen={marketOpen} />
        </div>
        <LevelLadder
          marketOpen={marketOpen}
          spxSpot={spxSpot}
          allDeltas={allDeltas}
          quotesFetchedAt={quotesFetchedAt}
          session={session}
        />
        <StrikeMoverLadder
          marketOpen={marketOpen}
          spxSpot={spxSpot}
          sessionAsOf={asOf}
          fallbackSpot={fallbackSpot}
        />
        <CharmClock marketOpen={marketOpen} />
        <GammaCompass marketOpen={marketOpen} />
        <DexoflowVelocityTape marketOpen={marketOpen} />
        <ConvexityMatrix marketOpen={marketOpen} />
      </div>
      <p className="text-tertiary mt-3 text-[10px] leading-relaxed">
        GEXBot Orderflow-tier data — taker-side exposure and flow metrics for 14
        underlyings (plus ES_SPX / NQ_NDX futures views of SPX / NDX), captured
        every minute during market hours.
      </p>
    </SectionBox>
  );
}

export const GexbotSection = memo(GexbotSectionInner);
