/**
 * PreMarketSignals: body of App's "Pre-Market Signals" panel
 * (`sec-premarket`), the Opening Flow Signal and the 0DTE Pin Setup tile.
 *
 * Each sits in its own labeled <ErrorBoundary>, so a render error in one
 * degrades that card to an inline fallback and leaves the other card, and
 * the rest of the page, standing. Before this, both rendered with no
 * boundary between them and the root one.
 *
 * Spec: docs/superpowers/specs/panel-payload-guards-2026-10-28.md (phase 1)
 */

import ErrorBoundary from './ErrorBoundary';
import { OpeningFlowSignal } from './OpeningFlowSignal';
import PinSetupTile from './PinSetupTile';
import { SectionBox } from './ui';

interface Props {
  /** Whether the cash session is open; PinSetupTile polls only then. */
  readonly marketOpen: boolean;
}

export default function PreMarketSignals({ marketOpen }: Props) {
  return (
    <SectionBox label="Pre-Market Signals" collapsible>
      <ErrorBoundary label="Opening Flow Signal">
        <OpeningFlowSignal />
      </ErrorBoundary>
      <hr className="border-edge my-4" />
      <ErrorBoundary label="0DTE Pin Setup">
        <PinSetupTile marketOpen={marketOpen} />
      </ErrorBoundary>
    </SectionBox>
  );
}
