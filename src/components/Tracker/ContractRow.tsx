/**
 * ContractRow — one row in the Active/Watchlist table. Expandable to
 * reveal per-contract overrides (thresholds + spot alerts) and a close
 * action. PnL is computed from the joined `latest_*` columns; direction
 * (long/short) flips the sign.
 */

import { memo, useCallback, useId, useState } from 'react';

import type {
  ContractUpdateInput,
  SpotAlert,
  TrackerContract,
} from './types.js';
import {
  computePnl,
  dteFromExpiry,
  formatContractShort,
  formatDollar,
  formatSignedDollar,
  formatSignedPct,
} from './helpers.js';
import { ThresholdsEditor } from './ThresholdsEditor.js';
import { SpotAlertsEditor } from './SpotAlertsEditor.js';

interface Props {
  contract: TrackerContract;
  hasUnreadAlert: boolean;
  onUpdate: (id: number, body: ContractUpdateInput) => Promise<void>;
  onClose: (id: number, closedPrice: number) => Promise<void>;
}

function pctColor(pct: number | null): string {
  if (pct == null) return 'text-secondary';
  if (pct > 0) return 'text-success';
  if (pct < 0) return 'text-danger';
  return 'text-secondary';
}

export const ContractRow = memo(function ContractRow({
  contract,
  hasUnreadAlert,
  onUpdate,
  onClose,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeDraft, setCloseDraft] = useState('');
  const [closeError, setCloseError] = useState<string | null>(null);
  const detailsId = useId();

  const dte = dteFromExpiry(contract.expiry);
  const dteAmber = dte <= 7;
  const { current, deltaDollar, deltaPct } = computePnl(contract);

  const handleThresholdsChange = useCallback(
    (up: number[] | null, down: number[] | null) => {
      void onUpdate(contract.id, {
        up_thresholds: up,
        down_thresholds: down,
      });
    },
    [contract.id, onUpdate],
  );

  const handleSpotAlertsChange = useCallback(
    (next: SpotAlert[] | null) => {
      void onUpdate(contract.id, { spot_alerts: next });
    },
    [contract.id, onUpdate],
  );

  const handleClose = useCallback(async () => {
    setCloseError(null);
    const price = Number.parseFloat(closeDraft);
    if (!Number.isFinite(price) || price <= 0) {
      setCloseError('Enter a positive close price');
      return;
    }
    setClosing(true);
    try {
      await onClose(contract.id, price);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Close failed');
    } finally {
      setClosing(false);
    }
  }, [closeDraft, contract.id, onClose]);

  return (
    <>
      <tr
        id={`tracker-row-${String(contract.id)}`}
        data-testid={`tracker-row-${String(contract.id)}`}
        className={
          'border-edge border-b transition-colors ' +
          (hasUnreadAlert ? 'bg-accent-bg' : 'hover:bg-surface-alt')
        }
      >
        <td className="px-2 py-2 font-mono text-[12px] font-semibold">
          {contract.ticker}
        </td>
        <td className="px-2 py-2 font-mono text-[12px]">
          {formatContractShort(contract)}
        </td>
        <td className="px-2 py-2 text-right font-mono text-[12px]">
          {formatDollar(Number.parseFloat(contract.entry_price))}
        </td>
        <td className="px-2 py-2 text-right font-mono text-[12px]">
          {formatDollar(current)}
        </td>
        <td
          className={
            'px-2 py-2 text-right font-mono text-[12px] ' +
            pctColor(deltaDollar)
          }
        >
          {formatSignedDollar(deltaDollar)}
        </td>
        <td
          className={
            'px-2 py-2 text-right font-mono text-[12px] font-semibold ' +
            pctColor(deltaPct)
          }
        >
          {formatSignedPct(deltaPct)}
        </td>
        <td
          className={
            'px-2 py-2 text-right font-mono text-[12px] ' +
            (dteAmber ? 'text-caution' : 'text-secondary')
          }
        >
          {dte}
        </td>
        <td className="px-2 py-2 text-right font-mono text-[12px]">
          {contract.quantity}
        </td>
        <td className="px-2 py-2 font-sans text-[12px]">
          <span
            title={contract.notes ?? ''}
            className="block max-w-32 truncate"
          >
            {contract.notes ?? '—'}
          </span>
        </td>
        <td className="px-2 py-2 text-right">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={
              expanded
                ? `Collapse details for ${contract.ticker}`
                : `Expand details for ${contract.ticker}`
            }
            className="text-accent hover:bg-accent-bg cursor-pointer rounded px-1.5 py-0.5 font-sans text-[11px] font-semibold"
          >
            {expanded ? 'Hide' : 'Details'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr id={detailsId} className="border-edge bg-surface-alt border-b">
          <td colSpan={10} className="px-4 py-3">
            <div className="space-y-4">
              <ThresholdsEditor
                upThresholds={
                  contract.up_thresholds
                    ? contract.up_thresholds.map(Number)
                    : null
                }
                downThresholds={
                  contract.down_thresholds
                    ? contract.down_thresholds.map(Number)
                    : null
                }
                onChange={handleThresholdsChange}
              />
              <SpotAlertsEditor
                ticker={contract.ticker}
                spotAlerts={contract.spot_alerts}
                onChange={handleSpotAlertsChange}
              />

              {contract.status === 'active' ? (
                <div className="border-edge flex flex-wrap items-center gap-2 border-t pt-3">
                  <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
                    Close position
                  </span>
                  <label className="flex items-center gap-1.5">
                    <span className="text-tertiary font-sans text-[11px]">
                      Closed price
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={closeDraft}
                      onChange={(e) => setCloseDraft(e.target.value)}
                      placeholder="e.g. 8.40"
                      aria-label="Closed price"
                      className="border-edge bg-surface focus:border-accent w-24 rounded border px-1.5 py-0.5 font-mono text-[11px] outline-none"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={closing}
                    className="bg-accent cursor-pointer rounded px-3 py-1 font-sans text-[12px] font-semibold text-white disabled:opacity-50"
                  >
                    {closing ? 'Closing…' : 'Close'}
                  </button>
                  {closeError && (
                    <span
                      role="alert"
                      className="text-danger font-sans text-[11px]"
                    >
                      {closeError}
                    </span>
                  )}
                </div>
              ) : (
                <ClosedSummary contract={contract} />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
});

/**
 * Read-only summary for closed/expired rows. The Active-only close form
 * is gated out for these rows (it's nonsensical to close an already
 * closed position); this strip just reports when and at what price the
 * contract was closed.
 */
function ClosedSummary({ contract }: { contract: TrackerContract }) {
  const closedPrice = contract.closed_price
    ? Number.parseFloat(contract.closed_price)
    : null;
  const closedAtRaw = contract.closed_at;
  // Format the closed_at timestamptz as YYYY-MM-DD without pulling in a
  // date library — UTC is fine for display, the row is historical.
  const closedAtDate = closedAtRaw ? closedAtRaw.slice(0, 10) : null;
  const priceLabel = closedPrice == null ? '—' : formatDollar(closedPrice);
  const dateLabel = closedAtDate ?? '—';
  return (
    <div className="border-edge flex flex-wrap items-center gap-2 border-t pt-3">
      <span className="text-tertiary font-sans text-[11px] font-semibold uppercase">
        Closed
      </span>
      <span className="text-secondary font-mono text-[11px]">
        Closed at {priceLabel} on {dateLabel}
      </span>
    </div>
  );
}
