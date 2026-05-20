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
import { CrossAssetSkewDashboard } from './CrossAssetSkewDashboard';
import { DexoflowVelocityTape } from './DexoflowVelocityTape';
import { GammaCompass } from './GammaCompass';
import { StrikeMoverLadder } from './StrikeMoverLadder';
import { VixDealerStateBadge } from './VixDealerStateBadge';

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
    <SectionBox label="GEXBot Dealer State" collapsible>
      <div className="flex flex-col gap-3">
        <StrikeMoverLadder marketOpen={marketOpen} spxSpot={spxSpot} />
        <VixDealerStateBadge marketOpen={marketOpen} />
        <CharmClock marketOpen={marketOpen} />
        <GammaCompass marketOpen={marketOpen} />
        <DexoflowVelocityTape marketOpen={marketOpen} />
        <ConvexityMatrix marketOpen={marketOpen} />
        <CrossAssetSkewDashboard marketOpen={marketOpen} />
      </div>
      <p className="text-tertiary mt-3 text-[10px] leading-relaxed">
        GEXBot Orderflow-tier data — capture pipeline ships dealer positioning +
        flow metrics for 16 Index/ETF tickers every minute during market hours.
      </p>
    </SectionBox>
  );
}

export const GexbotSection = memo(GexbotSectionInner);
