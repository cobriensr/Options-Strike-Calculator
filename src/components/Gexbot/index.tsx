/**
 * GexbotSection — dedicated section housing the GEXBot trial-data
 * components. Spec:
 * docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 *
 * Children consume their own data via useGexbotData. The section
 * itself is just a layout container that forwards `marketOpen` (used
 * for polling gating) and the live SPX spot (used by StrikeMoverLadder
 * to anchor the ladder).
 *
 * The Sibling-Asset Confirmation Bar lives inline in lottery/silent-
 * boom rows, not in this section.
 */

import { memo } from 'react';

import { SectionBox } from '../ui';
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

function GexbotSectionInner({ marketOpen, spxSpot }: GexbotSectionProps) {
  return (
    <SectionBox label="GEXBot Taker Flow" collapsible>
      <div className="flex flex-col gap-3">
        <DealerStateSummaryStrip marketOpen={marketOpen} />
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <ExpectedMoveTile marketOpen={marketOpen} />
          <NetVannaTile marketOpen={marketOpen} />
        </div>
        <StrikeMoverLadder marketOpen={marketOpen} spxSpot={spxSpot} />
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
