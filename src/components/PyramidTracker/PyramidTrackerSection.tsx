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
 * Task 2B: wires the ChainFormModal + LegFormModal — the "+ New Chain" button
 * opens ChainFormModal in create mode; leg modal state is scaffolded here so
 * Task 2C can trigger it from the per-chain action buttons.
 * Task 2C (this file): renders ProgressCounter, ExportCSVButton, and ChainList
 * below the "+ New Chain" button. Leg cache invalidation flows through a
 * forwardRef handle exposed by ChainList so a successful leg mutation drops
 * the cached leg list for its chain and the next expand refetches.
 */

import { useCallback, useId, useRef, useState } from 'react';
import type { PyramidChain, PyramidLeg } from '../../types/pyramid';
import { usePyramidData } from '../../hooks/usePyramidData';
import ChainFormModal from './ChainFormModal';
import LegFormModal from './LegFormModal';
import ChainList, { type ChainListHandle } from './ChainList';
import ProgressCounter from './ProgressCounter';
import ExportCSVButton from './ExportCSVButton';

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

/**
 * Inner body separated so the kill switch can short-circuit before
 * `usePyramidData` fetches anything. Once this function runs, the feature
 * is live and data-loading begins.
 */
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
    deleteChain,
    getChainWithLegs,
    createLeg,
    updateLeg,
    deleteLeg,
  } = usePyramidData();

  const [modal, setModal] = useState<ModalState>(null);
  const closeModal = useCallback(() => setModal(null), []);

  // Imperative handle to ChainList's internal legs cache. Used after any leg
  // mutation so the next expand of that chain refetches fresh data.
  const chainListRef = useRef<ChainListHandle | null>(null);

  // Load ALL legs across every chain for CSV export. Runs the per-chain
  // endpoint sequentially for simplicity (low volumes — see ExportCSVButton
  // comment); switching to Promise.all is a future optimisation if needed.
  const fetchAllLegs = useCallback(async (): Promise<PyramidLeg[]> => {
    const all: PyramidLeg[] = [];
    for (const c of chains) {
      const { legs } = await getChainWithLegs(c.id);
      all.push(...legs);
    }
    return all;
  }, [chains, getChainWithLegs]);

  const handleDeleteChain = useCallback(
    async (chainId: string) => {
      // Native confirm — lightweight, no modal-on-modal overlays. SPA
      // context guarantees a window; `globalThis.confirm` satisfies the
      // sonar window-preference rule without the typeof guard.
      const ok = globalThis.confirm(
        `Delete chain ${chainId}? This cascades to all its legs.`,
      );
      if (!ok) return;
      await deleteChain(chainId);
      chainListRef.current?.clearLegsCache(chainId);
    },
    [deleteChain],
  );

  const handleDeleteLeg = useCallback(
    async (legId: string) => {
      const ok = globalThis.confirm('Delete this leg?');
      if (!ok) return;
      await deleteLeg(legId);
    },
    [deleteLeg],
  );

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
            <div className="flex flex-col gap-3 py-2">
              {progress != null && <ProgressCounter progress={progress} />}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setModal({ kind: 'chain-create' })}
                  className="bg-accent cursor-pointer rounded-md px-3 py-1.5 font-sans text-xs font-bold tracking-wider text-white uppercase"
                >
                  + New Chain
                </button>
                <ExportCSVButton chains={chains} fetchAllLegs={fetchAllLegs} />
              </div>

              <ChainList
                ref={chainListRef}
                chains={chains}
                getChainWithLegs={getChainWithLegs}
                onEditChain={(chain) => setModal({ kind: 'chain-edit', chain })}
                onDeleteChain={handleDeleteChain}
                onEditLeg={(leg) =>
                  setModal({ kind: 'leg-edit', chainId: leg.chain_id, leg })
                }
                onDeleteLeg={handleDeleteLeg}
                onAddLeg={(chainId) =>
                  setModal({ kind: 'leg-create', chainId })
                }
              />
            </div>
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
            chainListRef.current?.clearLegsCache(values.chain_id);
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
            chainListRef.current?.clearLegsCache(modal.chainId);
          }}
        />
      )}
    </section>
  );
}
