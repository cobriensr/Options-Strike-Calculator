/**
 * TrackerSection — top-level section for the Contract Tracker feature.
 *
 * Wires the two hooks (`useTrackerContracts`, `useTrackerAlerts`)
 * together with the tab switcher and table renderer. Three tabs:
 *
 *   - Active:    `status='active'` rows
 *   - Watchlist: filtered Active rows where DTE ≤ 7 OR has unread alert
 *   - Archive:   `status='closed'|'expired'` rows + stats card
 *
 * Polling is gated by `marketOpen` for Active (cron only fires during
 * RTH), and disabled entirely for Archive (rows are static). The alerts
 * hook polls independently every 30s while the section is mounted.
 */

import { memo, useCallback, useMemo, useState } from 'react';

import { useTrackerContracts } from '../../hooks/useTrackerContracts.js';
import { useTrackerAlerts } from '../../hooks/useTrackerAlerts.js';
import { SectionBox } from '../ui/SectionBox.js';
import { TrackerTabs, type TrackerTab } from './TrackerTabs.js';
import { ContractTable, type GroupMode } from './ContractTable.js';
import { AddContractForm } from './AddContractForm.js';
import { ArchiveStats } from './ArchiveStats.js';
import { isWatchlistContract } from './helpers.js';
import type {
  ContractCreateInput,
  ContractFreeTextInput,
  ContractUpdateInput,
} from './types.js';

interface Props {
  marketOpen: boolean;
}

export const TrackerSection = memo(function TrackerSection({
  marketOpen,
}: Props) {
  const [tab, setTab] = useState<TrackerTab>('active');
  const [groupBy, setGroupBy] = useState<GroupMode>('expiration');
  const [addOpen, setAddOpen] = useState(false);
  // Mirror the SectionBox collapsed state so all three polling hooks
  // pause while the section is hidden. SectionBox is `defaultCollapsed`
  // (Phase 3 spec) — seed `true` and flip on the user's first expand.
  const [collapsed, setCollapsed] = useState(true);
  const handleCollapsedChange = useCallback(
    (next: boolean) => setCollapsed(next),
    [],
  );

  // Active rows feed both the Active tab and the Watchlist derived
  // view. Polling is gated on marketOpen since the refresh-tracker
  // cron only runs during RTH; also paused when the section is
  // collapsed so background polling doesn't run for a hidden panel.
  const active = useTrackerContracts({
    status: 'active',
    enabled: !collapsed && (tab === 'active' || tab === 'watchlist'),
    marketOpen,
  });

  // Archive rows are static — polling is disabled, but we still want
  // a fresh fetch when the user switches to the tab.
  const archive = useTrackerContracts({
    status: 'closed',
    enabled: !collapsed && tab === 'archive',
    marketOpen: false,
  });

  // Alert polling runs while the section is expanded. The hook
  // de-duplicates against ids it has already shown so reopening the
  // section doesn't re-fire historical toasts.
  const handleSelectContract = useCallback((contractId: number) => {
    const el = document.getElementById(`tracker-row-${String(contractId)}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight pulse via CSS class — falls back gracefully
      // if the class isn't defined (no-op).
      el.classList.add('ring-2', 'ring-accent');
      setTimeout(() => el.classList.remove('ring-2', 'ring-accent'), 2000);
    }
  }, []);

  const alerts = useTrackerAlerts({
    enabled: !collapsed,
    marketOpen,
    onSelectContract: handleSelectContract,
  });

  const watchlistRows = useMemo(
    () => active.data.filter((c) => isWatchlistContract(c, alerts.data)),
    [active.data, alerts.data],
  );

  const counts = useMemo<Record<TrackerTab, number>>(
    () => ({
      active: active.data.length,
      watchlist: watchlistRows.length,
      archive: archive.data.length,
    }),
    [active.data.length, watchlistRows.length, archive.data.length],
  );

  const handleCreate = useCallback(
    async (body: ContractCreateInput | ContractFreeTextInput) => {
      await active.create(body);
    },
    [active],
  );

  const handleUpdate = useCallback(
    async (id: number, body: ContractUpdateInput) => {
      if (tab === 'archive') {
        await archive.update(id, body);
      } else {
        await active.update(id, body);
      }
    },
    [tab, active, archive],
  );

  const handleClose = useCallback(
    async (id: number, closedPrice: number) => {
      await active.close(id, closedPrice);
    },
    [active],
  );

  const visibleRows =
    tab === 'archive'
      ? archive.data
      : tab === 'watchlist'
        ? watchlistRows
        : active.data;

  const loading = tab === 'archive' ? archive.loading : active.loading;
  const error = tab === 'archive' ? archive.error : active.error;

  return (
    <SectionBox
      label="Contract Tracker"
      collapsible
      defaultCollapsed
      onCollapsedChange={handleCollapsedChange}
    >
      <TrackerTabs current={tab} onChange={setTab} counts={counts} />

      {tab !== 'archive' && (
        <div className="mb-3 flex items-center justify-end">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            aria-label="Add new contract to tracker"
            className="bg-accent cursor-pointer rounded px-3 py-1.5 font-sans text-[12px] font-semibold text-white"
          >
            + Add Contract
          </button>
        </div>
      )}

      {tab === 'archive' && <ArchiveStats contracts={archive.data} />}

      {loading && (
        <div className="text-tertiary py-4 text-center font-sans text-[12px]">
          Loading…
        </div>
      )}
      {error && (
        <div role="alert" className="text-danger py-4 font-sans text-[12px]">
          {error}
        </div>
      )}

      {!loading && (
        <ContractTable
          contracts={visibleRows}
          alerts={alerts.data}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          onUpdate={handleUpdate}
          onClose={handleClose}
        />
      )}

      <AddContractForm
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreate={handleCreate}
      />
    </SectionBox>
  );
});
