/**
 * FuturesGammaPlaybook — container shell for the five-panel playbook widget.
 *
 * Phase 1B scope: hosts the first two panels (RegimeHeader + PlaybookPanel)
 * and wires the `ScrubControls` header slot so the trader can rewind through
 * historical snapshots, mirroring `GexLandscape`. Panels 3–5 land in later
 * phases (EsLevelsPanel in 1C, RegimeTimeline in 1C, TriggersPanel in 1D) —
 * the grid slots for those live here but stay empty until then.
 *
 * Data: a single `useFuturesGammaPlaybook(marketOpen)` call. That hook owns
 * both upstream fetches (`useGexPerStrike` + `useFuturesData`) plus the
 * derived regime/verdict/phase/rules/bias state, and passes through the
 * scrub controls so this shell stays thin.
 *
 * `onBiasChange` fires whenever the compact `PlaybookBias` payload changes,
 * giving App.tsx a hook to forward the bias into the analyze endpoint. The
 * callback fires via a stable JSON serialization so it never fires on every
 * parent tick — only when a field actually changes.
 */

import { useEffect, useMemo, useRef } from 'react';
import { SectionBox } from '../ui';
import { ScrubControls } from '../ScrubControls';
import { useFuturesGammaPlaybook } from '../../hooks/useFuturesGammaPlaybook';
import { RegimeHeader } from './RegimeHeader';
import { PlaybookPanel } from './PlaybookPanel';
import { EsLevelsPanel } from './EsLevelsPanel';
import { RegimeTimeline } from './RegimeTimeline';
import { TriggersPanel } from './TriggersPanel';
import { AlertConfigPanel } from './AlertConfig';
import { useAlertDispatcher } from './useAlertDispatcher';
import type { AlertState } from './alerts';
import type { PlaybookBias } from './types';

export interface FuturesGammaPlaybookProps {
  marketOpen: boolean;
  /**
   * Fired when the `PlaybookBias` payload changes. App.tsx forwards it to
   * the analyze endpoint so Claude sees the current verdict + ES levels.
   */
  onBiasChange?: (bias: PlaybookBias) => void;
}

/**
 * The container itself is NOT wrapped in `React.memo`. Its render is driven
 * entirely by the hook's state — there are no expensive JSX children that
 * benefit from bailing out on parent renders, and the two sub-panels below
 * (`RegimeHeader`, `PlaybookPanel`) already have their own `React.memo`
 * wrappers. Memoizing the container on top would only confuse tests that
 * rely on the hook mock re-running to exercise effect pathways.
 */
function FuturesGammaPlaybook({
  marketOpen,
  onBiasChange,
}: FuturesGammaPlaybookProps) {
  const playbook = useFuturesGammaPlaybook(marketOpen);

  const {
    bias,
    rules,
    verdict,
    phase,
    loading,
    error,
    timestamp,
    timestamps,
    selectedDate,
    setSelectedDate,
    isLive,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubTo,
    scrubLive,
    refresh,
  } = playbook;

  // Fire `onBiasChange` only when the serialized bias actually changes. This
  // avoids re-firing on every parent re-render — critical because App.tsx
  // wires the callback into the analyze context setter.
  const lastBiasSigRef = useRef<string | null>(null);
  const biasSig = useMemo(() => JSON.stringify(bias), [bias]);
  useEffect(() => {
    if (!onBiasChange) return;
    if (lastBiasSigRef.current === biasSig) return;
    lastBiasSigRef.current = biasSig;
    onBiasChange(bias);
  }, [bias, biasSig, onBiasChange]);

  // Alert dispatcher — composes a pure `AlertState` from the hook's output
  // and delegates edge detection + delivery to `useAlertDispatcher`. When
  // `isLive === false` the dispatcher only logs to `backtestAlerts` without
  // firing any toast / Notification / audio — see that hook's docs.
  const alertState: AlertState = useMemo(
    () => ({
      regime: playbook.regime,
      phase: playbook.phase,
      levels: playbook.levels,
      firedTriggers: playbook.bias.firedTriggers,
      esPrice: playbook.esPrice,
    }),
    [
      playbook.regime,
      playbook.phase,
      playbook.levels,
      playbook.bias.firedTriggers,
      playbook.esPrice,
    ],
  );
  const alertDispatcher = useAlertDispatcher({
    state: alertState,
    isLive,
  });

  const headerRight = (
    <div className="flex items-center gap-2">
      <AlertConfigPanel
        config={alertDispatcher.config}
        setConfig={alertDispatcher.setConfig}
        permission={alertDispatcher.permission}
        requestPermission={alertDispatcher.requestNotificationPermission}
      />
      <ScrubControls
        timestamp={timestamp}
        timestamps={timestamps}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        isLive={isLive}
        isScrubbed={isScrubbed}
        canScrubPrev={canScrubPrev}
        canScrubNext={canScrubNext}
        onScrubPrev={scrubPrev}
        onScrubNext={scrubNext}
        onScrubTo={scrubTo}
        onScrubLive={scrubLive}
        onRefresh={refresh}
        loading={loading}
        sectionLabel="Futures Gamma Playbook"
      />
    </div>
  );

  if (loading && rules.length === 0 && bias.esZeroGamma === null) {
    return (
      <SectionBox
        label="FUTURES GAMMA PLAYBOOK"
        headerRight={headerRight}
        collapsible
      >
        <div className="text-muted flex items-center justify-center py-8 font-mono text-[13px]">
          Loading futures gamma playbook…
        </div>
      </SectionBox>
    );
  }

  if (error) {
    return (
      <SectionBox
        label="FUTURES GAMMA PLAYBOOK"
        headerRight={headerRight}
        collapsible
      >
        <div
          role="alert"
          className="text-danger py-4 text-center font-mono text-[13px]"
        >
          {error.message}
        </div>
      </SectionBox>
    );
  }

  return (
    <SectionBox
      label="FUTURES GAMMA PLAYBOOK"
      headerRight={headerRight}
      collapsible
    >
      {/* Panel 1: Regime header (full width) */}
      <RegimeHeader playbook={playbook} />

      {/* Panel 2: Playbook rules cheat sheet (full width) */}
      <PlaybookPanel
        rules={rules}
        verdict={verdict}
        phase={phase}
        esZeroGammaKnown={bias.esZeroGamma !== null}
      />

      {/* Panel 3: SPX-derived walls mapped to ES prices (full width) */}
      <EsLevelsPanel levels={playbook.levels} />

      {/* Panel 4: Intraday regime timeline + price overlay (full width) */}
      <RegimeTimeline
        timeline={playbook.regimeTimeline}
        sessionPhaseBoundaries={playbook.sessionPhaseBoundaries}
        isScrubbed={playbook.isScrubbed}
        scrubbedTimestamp={playbook.timestamp}
      />

      {/* Panel 5: Named-setup trigger checklist (full width) */}
      <TriggersPanel
        regime={playbook.regime}
        phase={playbook.phase}
        esPrice={playbook.esPrice}
        levels={playbook.levels}
      />
    </SectionBox>
  );
}

export default FuturesGammaPlaybook;
