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
 * The Sibling-Asset Confirmation Bar lives inline in lottery/silent-
 * boom rows, not in this section.
 */

import { memo } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import { ClosedBadge, SectionBox } from '../ui';
import { CharmClock } from './CharmClock';
import { ConvexityMatrix } from './ConvexityMatrix';
import { DealerStateSummaryStrip } from './DealerStateSummaryStrip';
import { DexoflowVelocityTape } from './DexoflowVelocityTape';
import { ExpectedMoveTile } from './ExpectedMoveTile';
import { GammaCompass } from './GammaCompass';
import { NetVannaTile } from './NetVannaTile';
import { StrikeMoverLadder } from './StrikeMoverLadder';

interface GexbotSectionProps {
  marketOpen: boolean;
  /**
   * Live SPX spot (Schwab via useMarketData). Forwarded to
   * StrikeMoverLadder; other children don't use it.
   */
  spxSpot: number | null;
}

const SNAPSHOTS_SPEC = { view: 'snapshots-latest' as const };

function GexbotSectionInner({ marketOpen, spxSpot }: GexbotSectionProps) {
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
