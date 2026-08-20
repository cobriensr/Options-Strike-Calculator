/**
 * useTrackerAlerts — polls GET /api/tracker/alerts/unread every 30s
 * while `enabled` is true. New alerts (i.e. ids not seen in the
 * previous poll) fire a Sonner-style toast via the project's
 * `useToast()` bridge. Clicking the toast scrolls the matching
 * contract row into view and acks the alert server-side.
 *
 * The toast handler is opt-in: pass `onToast` to override the default
 * implementation (used by the section to scroll-to-row, and by the
 * tests to assert behavior without coupling to the real Toast portal).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TrackerAlert } from '../components/Tracker/types.js';
import { buildAlertToast } from '../components/Tracker/helpers.js';
import { useToast } from './useToast.js';
import { usePolling } from './usePolling.js';
import { getErrorMessage } from '../utils/error.js';

const POLL_INTERVAL_MS = 30_000;

// ── Response validation ────────────────────────────────────
// Same model as useTrackerContracts / `validateSpike` (useVegaSpikes):
// validate at the parse, drop bad rows, reject a bad envelope.
//
// The identity cast here didn't crash the section (the `for (const a of
// incoming)` throw lands in this hook's own catch), but it lost data: a
// single unusable row aborted the loop BEFORE `setData`, so every
// healthy unread alert in the same response was discarded and the
// Watchlist tab silently under-counted.
//
// Field types mirror what `GET /api/tracker/alerts/unread` returns
// (migration 163 joined to tracker_contracts): NUMERIC as strings,
// `id` from a BIGSERIAL — which the Neon driver may hand back as a
// string — so ids accept `number | numeric string` and normalize.

/** BIGSERIAL/INTEGER id, tolerant of a BIGINT arriving as a string. */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** NUMERIC-as-string, tolerant of a driver that hands back numbers. */
function toNumericString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function toNullableString(v: unknown): string | null {
  if (v == null) return null;
  return toNumericString(v);
}

function isAlertType(v: unknown): v is TrackerAlert['alert_type'] {
  return (
    v === 'up_pct' || v === 'down_pct' || v === 'spot_level' || v === 'dte_7'
  );
}

/**
 * Validate one joined unread-alert row. Returns the typed row, or `null`
 * on any load-bearing field mismatch so the caller drops just that row.
 * `id` / `contract_id` drive the seen-set, the ack call and the
 * watchlist join; `ticker` / `expiry` / `side` / `strike` are read by
 * `buildAlertToast` (where `formatExpiryMD` splits `expiry`).
 */
function validateAlert(raw: unknown): TrackerAlert | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = toFiniteNumber(r.id);
  const contractId = toFiniteNumber(r.contract_id);
  const threshold = toNumericString(r.threshold);
  const strike = toNumericString(r.strike);
  const entryPrice = toNumericString(r.entry_price);
  const quantity = toFiniteNumber(r.quantity);
  if (
    id === null ||
    contractId === null ||
    threshold === null ||
    strike === null ||
    entryPrice === null ||
    quantity === null ||
    !isAlertType(r.alert_type) ||
    typeof r.ticker !== 'string' ||
    typeof r.occ_symbol !== 'string' ||
    typeof r.expiry !== 'string' ||
    (r.side !== 'C' && r.side !== 'P') ||
    (r.direction !== 'long' && r.direction !== 'short') ||
    (r.contract_status !== 'active' &&
      r.contract_status !== 'closed' &&
      r.contract_status !== 'expired')
  ) {
    return null;
  }
  return {
    id,
    contract_id: contractId,
    fired_at: typeof r.fired_at === 'string' ? r.fired_at : '',
    alert_type: r.alert_type,
    threshold,
    price_at_fire: toNullableString(r.price_at_fire),
    underlying_at_fire: toNullableString(r.underlying_at_fire),
    acknowledged: r.acknowledged === true,
    occ_symbol: r.occ_symbol,
    ticker: r.ticker,
    // Normalize to the YYYY-MM-DD the type documents. Unlike
    // /api/tracker/contracts, the unread endpoint does NOT TO_CHAR its
    // `expiry`, so the DATE column arrives as a JS Date hydrated by the
    // Neon driver and JSON-serialized to `2026-05-08T00:00:00.000Z` —
    // which `formatExpiryMD` (splits on '-') renders as the garbage
    // toast label `05/08T00:00:00.000Z`. Slicing here is a no-op for an
    // already-plain date.
    expiry: r.expiry.slice(0, 10),
    strike,
    side: r.side,
    direction: r.direction,
    entry_price: entryPrice,
    quantity,
    contract_status: r.contract_status,
  };
}

/**
 * Validate the unread envelope. Returns the surviving rows, or `null`
 * when the body isn't an alerts payload at all — the caller then throws
 * into its existing error path.
 */
function validateUnreadAlerts(raw: unknown): TrackerAlert[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.alerts)) return null;
  const out: TrackerAlert[] = [];
  for (const row of r.alerts) {
    const valid = validateAlert(row);
    if (valid) out.push(valid);
  }
  return out;
}

export interface UseTrackerAlertsArgs {
  enabled?: boolean;
  /**
   * When false, the hook performs ONE initial fetch on mount (so the
   * seen-id set seeds correctly) but skips the recurring 30s poll.
   * Re-enabling flips polling back on without re-seeding. The project
   * convention is to gate polling on the parent market-open flag —
   * the refresh-tracker cron only fires during RTH, so off-hours polls
   * are wasted requests.
   */
  marketOpen?: boolean;
  /**
   * Called when the user clicks a fired-alert toast. The default
   * implementation in `TrackerSection` scrolls the matching contract
   * row into view; tests pass a spy.
   */
  onSelectContract?: (contractId: number) => void;
}

export interface UseTrackerAlertsState {
  data: TrackerAlert[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  refresh: () => Promise<void>;
  ack: (id: number) => Promise<void>;
}

/**
 * Acknowledge an alert via POST /api/tracker/alerts/:id/ack. Failures
 * are swallowed (logged via console.warn) — the user's click should
 * not raise a UI error if the network drops.
 */
async function ackAlert(id: number): Promise<void> {
  try {
    const res = await fetch(`/api/tracker/alerts/${String(id)}/ack`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      console.warn(`tracker-alerts ack failed: HTTP ${String(res.status)}`);
    }
  } catch (err) {
    console.warn('tracker-alerts ack threw', err);
  }
}

export function useTrackerAlerts({
  enabled = true,
  marketOpen = false,
  onSelectContract,
}: UseTrackerAlertsArgs = {}): UseTrackerAlertsState {
  const toast = useToast();
  const [data, setData] = useState<TrackerAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  // Track which alert ids we've already shown a toast for. Without
  // this, every 30s poll would re-fire the same toasts until the user
  // acks each one.
  const seenIdsRef = useRef<Set<number>>(new Set());
  // First fetch is "initial population" — we don't fire toasts for
  // alerts that already existed before the user opened the app.
  const isFirstFetchRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  // Snapshot the callback so the polling effect doesn't tear down on
  // every parent re-render.
  const onSelectRef = useRef(onSelectContract);
  useEffect(() => {
    onSelectRef.current = onSelectContract;
  }, [onSelectContract]);

  // Forward-ref to ack(). The toast onClick fires asynchronously (after
  // user interaction), so by the time it runs the real `ack` callback
  // has been defined. Using a ref avoids the TDZ on the initial render.
  const ackRef = useRef<((id: number) => Promise<void>) | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/tracker/alerts/unread', {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const incoming = validateUnreadAlerts(await res.json());
      if (ctrl.signal.aborted) return;
      if (incoming === null) throw new Error('Unexpected response shape');

      if (isFirstFetchRef.current) {
        // Seed the seen-set with the initial server state so we don't
        // spam the user with toasts for alerts that fired before they
        // opened the tab.
        for (const a of incoming) seenIdsRef.current.add(a.id);
        isFirstFetchRef.current = false;
      } else {
        // Subsequent polls — fire a toast for every id not in the
        // seen-set. Order newest-first so the latest pops on top.
        for (const a of incoming) {
          if (seenIdsRef.current.has(a.id)) continue;
          seenIdsRef.current.add(a.id);
          const { message, type } = buildAlertToast(a);
          // Clicking "Open" scrolls the matching row into view AND acks
          // the alert server-side. The optimistic local drop happens
          // inside `ack()`, so the next poll won't re-fire it.
          toast.show(message, type, {
            actionLabel: 'Open',
            onClick: () => {
              onSelectRef.current?.(a.contract_id);
              // ack() already swallows its own errors; ignore the
              // returned promise without `void` (sonarjs/void-use).
              ackRef.current?.(a.id).catch(() => {});
            },
          });
        }
      }

      setData(incoming);
      setError(null);
      setFetchedAt(Date.now());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      setError(getErrorMessage(err));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [toast]);

  // Eager mount fetch — seeds the seen-id set even off-hours so toasts
  // don't fire for alerts that existed before the user opened the tab.
  // usePolling only schedules the recurring tick.
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh();
  }, [enabled, refresh]);

  // Off-hours: skip the recurring poll. Project convention from CLAUDE.md
  // — the refresh cron only fires during RTH, so polling outside RTH
  // would just re-return the same payload every 30s.
  usePolling(refresh, POLL_INTERVAL_MS, [enabled, marketOpen]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ack = useCallback(async (id: number) => {
    await ackAlert(id);
    // Optimistically drop the row so the next poll doesn't re-fire it.
    setData((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Wire the ref so the toast onClick (defined inside refresh) can call
  // the latest `ack` without a circular useCallback dependency.
  useEffect(() => {
    ackRef.current = ack;
  }, [ack]);

  return useMemo(
    () => ({ data, loading, error, fetchedAt, refresh, ack }),
    [data, loading, error, fetchedAt, refresh, ack],
  );
}
