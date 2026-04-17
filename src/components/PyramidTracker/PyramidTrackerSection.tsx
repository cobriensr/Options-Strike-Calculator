/**
 * PyramidTrackerSection — top-level container for the pyramid trade
 * tracker experiment.
 *
 * Per spec (docs/superpowers/specs/pyramid-tracker-2026-04-16.md) this is
 * a droppable, single-owner logging tool mounted below the journal in
 * `App.tsx`. The kill switch is `VITE_PYRAMID_ENABLED` — when not exactly
 * `'true'` the component renders `null` silently so the feature can be
 * disabled in production without stale UI.
 *
 * Task 2A: collapsible shell + data hook plumbing + loading / error states.
 * Task 2B (this file): wires the ChainFormModal + LegFormModal — the "+ New
 * Chain" button opens ChainFormModal in create mode and calls the hook's
 * `createChain` mutation on save. Leg modal state is scaffolded here so
 * Task 2C (ChainList) can trigger it without touching this file again.
 */

import { useCallback, useId, useState } from 'react';
import type { PyramidChain, PyramidLeg } from '../../types/pyramid';
import { usePyramidData } from '../../hooks/usePyramidData';
import ChainFormModal from './ChainFormModal';
import LegFormModal from './LegFormModal';

/**
 * Kill-switch helper. `import.meta.env.VITE_PYRAMID_ENABLED` is injected
 * by Vite at build time (production) or set live by test runners via
 * `vi.stubEnv`. Compare against the exact string `'true'` — the env var
 * is serialized as a string and we want a positive opt-in, not a
 * truthy-cast trap. Read per render (not at module load) so tests can
 * toggle the switch without needing module-level resets.
 */
function isPyramidEnabled(): boolean {
  return import.meta.env.VITE_PYRAMID_ENABLED === 'true';
}

export default function PyramidTrackerSection() {
  // Kill switch fires before any hook work so the feature has zero runtime
  // cost when disabled. No log — silent per spec.
  if (!isPyramidEnabled()) return null;
  return <PyramidTrackerBody />;
}

/**
 * Inner body separated so the kill switch can short-circuit before
 * `usePyramidData` fetches anything. Once this function runs, the feature
 * is live and data-loading begins.
 */
/**
 * Discriminated union describing the current modal state. `null` means
 * neither modal is open. Using a union keeps chain/leg modals mutually
 * exclusive without two independent boolean flags.
 */
type ModalState =
  | null
  | { kind: 'chain-create' }
  | { kind: 'chain-edit'; chain: PyramidChain }
  | { kind: 'leg-create'; chainId: string }
  | { kind: 'leg-edit'; chainId: string; leg: PyramidLeg };

function PyramidTrackerBody() {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  const {
    chains,
    progress,
    loading,
    error,
    refresh,
    createChain,
    updateChain,
    createLeg,
    updateLeg,
  } = usePyramidData();

  const [modal, setModal] = useState<ModalState>(null);
  const closeModal = useCallback(() => setModal(null), []);

  // Surface the chain count in the collapsed header so the user can see
  // their progress without expanding — matches the default noted in the
  // task prompt ("show the chain count from progress in the header even
  // when collapsed"). Falls back to the chains array length until the
  // progress endpoint resolves so the badge isn't jumpy on first load.
  const chainCount = progress?.total_chains ?? chains.length;

  const isOwnerError = error?.toLowerCase().includes('owner access') ?? false;

  return (
    <section
      aria-label="Pyramid Trade Tracker"
      className="bg-surface border-edge border-t-accent animate-fade-in-up mt-6 flex flex-col rounded-[14px] border-[1.5px] border-t-[3px] p-[18px] pb-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"
    >
      <div
        className={
          (expanded ? 'mb-3.5 ' : '') + 'flex items-center justify-between'
        }
      >
        <button
          type="button"
          className="flex flex-1 cursor-pointer items-center gap-2.5 text-left select-none"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={contentId}
        >
          <span
            className="text-muted text-[12px] transition-transform duration-200"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            aria-hidden="true"
          >
            {'\u25BE'}
          </span>
          <div className="flex flex-col">
            <h2 className="text-tertiary font-sans text-[13px] font-bold tracking-[0.12em] uppercase">
              Pyramid Trade Tracker
            </h2>
            <span className="text-muted mt-0.5 font-sans text-[11px] tracking-normal normal-case">
              MNQ pyramid trade logging {'\u2014'} experiment
            </span>
          </div>
          <span
            className="text-accent bg-accent-bg ml-2 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
            aria-label={`${chainCount} chains logged`}
          >
            {chainCount} logged
          </span>
        </button>
      </div>

      {expanded && (
        <div
          id={contentId}
          className="flex min-h-0 flex-1 flex-col"
          data-testid="pyramid-tracker-content"
        >
          {loading && (
            <div
              role="status"
              aria-live="polite"
              className="text-muted flex items-center gap-2 py-6 text-sm"
            >
              <span
                className="border-edge border-t-accent inline-block h-3 w-3 animate-spin rounded-full border-2"
                aria-hidden="true"
              />
              <span>Loading pyramid data{'\u2026'}</span>
            </div>
          )}

          {!loading && isOwnerError && (
            <div
              role="alert"
              className="bg-surface-alt text-primary rounded-md p-3 text-sm"
            >
              Owner access required {'\u2014'} this section is read/write-gated
              to the single owner account.
            </div>
          )}

          {!loading && error != null && !isOwnerError && (
            <div
              role="alert"
              className="bg-surface-alt text-primary flex items-center justify-between rounded-md p-3 text-sm"
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={() => {
                  void refresh();
                }}
                className="border-edge-strong bg-chip-bg text-primary hover:bg-surface-alt ml-3 cursor-pointer rounded-md border-[1.5px] px-3 py-1 font-sans text-xs font-semibold"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && error == null && (
            <>
              <div className="flex items-center justify-between py-2">
                <button
                  type="button"
                  onClick={() => setModal({ kind: 'chain-create' })}
                  className="bg-accent cursor-pointer rounded-md px-3 py-1.5 font-sans text-xs font-bold tracking-wider text-white uppercase"
                >
                  + New Chain
                </button>
                {/* Task 2C slot: ProgressCounter renders summary here. */}
              </div>
              {/* Task 2C slot: ChainList + ChainCard + LegTable mount here. */}
              <p className="text-muted py-4 text-sm italic">
                List and per-feature counters coming in Task 2C.
              </p>
            </>
          )}
        </div>
      )}

      {modal?.kind === 'chain-create' && (
        <ChainFormModal
          mode="create"
          open
          onClose={closeModal}
          onSubmit={async (values) => {
            await createChain(values);
          }}
        />
      )}
      {modal?.kind === 'chain-edit' && (
        <ChainFormModal
          mode="edit"
          open
          initialChain={modal.chain}
          onClose={closeModal}
          onSubmit={async (values) => {
            await updateChain(modal.chain.id, values);
          }}
        />
      )}
      {modal?.kind === 'leg-create' && (
        <LegFormModal
          mode="create"
          open
          chainId={modal.chainId}
          onClose={closeModal}
          onSubmit={async (values) => {
            await createLeg(values);
          }}
        />
      )}
      {modal?.kind === 'leg-edit' && (
        <LegFormModal
          mode="edit"
          open
          chainId={modal.chainId}
          initialLeg={modal.leg}
          onClose={closeModal}
          onSubmit={async (values) => {
            await updateLeg(modal.leg.id, values);
          }}
        />
      )}
    </section>
  );
}
