/**
 * useTrackerContracts — fetches /api/tracker/contracts for a given
 * status filter plus exposes CRUD helpers.
 *
 * Returns the existing-hook contract:
 *   `{ data, loading, error, refresh, mutate }`
 *
 * `mutate` is a synchronous client-side patch for optimistic updates
 * (e.g. closing a row); the caller is responsible for following up with
 * `refresh()` after the server PATCH resolves.
 *
 * The hook re-fetches whenever `status` or `marketOpen` changes, and
 * polls every 30s during market hours. Pass `enabled={false}` to
 * disable polling entirely (e.g. when the parent section is collapsed
 * or the access mode is public).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ContractCreateInput,
  ContractFreeTextInput,
  ContractStatus,
  ContractUpdateInput,
  SpotAlert,
  TrackerContract,
} from '../components/Tracker/types.js';
import { usePolling } from './usePolling.js';
import { getErrorMessage } from '../utils/error.js';

// ── Response validation ────────────────────────────────────
// Mirrors `validateSpike` (useVegaSpikes) / the row-level validator in
// useGexStrikeExpiry: validate at the parse, drop bad rows, reject a bad
// envelope. Casting the body straight to its response interface put
// `undefined` into `data` on a shapeless body (`{}`, an HTML error page
// parsed loosely, a 5xx JSON blob) and TrackerSection died on
// `active.data.filter(...)`; a row missing `expiry` died one frame later
// in `dteFromExpiry`'s `expiry.split('-')`.
//
// Field types mirror what `GET /api/tracker/contracts` actually returns
// (migration 161 + the LEFT JOIN LATERAL on tracker_contract_ticks):
// NUMERIC columns arrive as strings from the Neon driver, INTEGER as
// numbers, `expiry` as a TO_CHAR'd YYYY-MM-DD string. Numeric-ish fields
// accept `string | number` and normalize, so a driver-level type-parser
// change can never silently drop every legitimate row.

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** NUMERIC-as-string, tolerant of a driver that hands back numbers. */
function toNumericString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Nullable NUMERIC/TIMESTAMPTZ column — absent/null coalesce to null. */
function toNullableString(v: unknown): string | null {
  if (v == null) return null;
  return toNumericString(v);
}

/**
 * INTEGER column (id, quantity) — tolerant of a BIGINT/NUMERIC arriving
 * as a string, which is the Neon driver's default for those OIDs.
 */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `NUMERIC[]` threshold column — bad entries dropped, non-array → null. */
function toThresholds(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .map((x) => toNumericString(x))
    .filter((x): x is string => x !== null);
}

/** `JSONB` spot-alert column — bad entries dropped, non-array → null. */
function toSpotAlerts(v: unknown): SpotAlert[] | null {
  if (!Array.isArray(v)) return null;
  const out: SpotAlert[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const a = raw as Record<string, unknown>;
    const level = typeof a.level === 'number' ? a.level : Number(a.level);
    if (
      (a.op === '>=' || a.op === '<=' || a.op === '>' || a.op === '<') &&
      Number.isFinite(level)
    ) {
      out.push({ op: a.op, level });
    }
  }
  return out;
}

/**
 * Validate one row from `contracts`. Returns the typed row, or `null` on
 * any load-bearing field mismatch so the caller drops it — one bad row
 * can't take the table down. Optional/nullable columns degrade to
 * `null` instead of failing the row.
 */
function validateContract(raw: unknown): TrackerContract | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = toFiniteNumber(r.id);
  const strike = toNumericString(r.strike);
  const entryPrice = toNumericString(r.entry_price);
  const quantity = toFiniteNumber(r.quantity);
  if (
    id === null ||
    strike === null ||
    entryPrice === null ||
    quantity === null ||
    !isNonEmptyString(r.occ_symbol) ||
    !isNonEmptyString(r.ticker) ||
    // The `dteFromExpiry` / `formatExpiryMD` crash site.
    !isNonEmptyString(r.expiry) ||
    (r.side !== 'C' && r.side !== 'P') ||
    (r.direction !== 'long' && r.direction !== 'short') ||
    (r.status !== 'active' && r.status !== 'closed' && r.status !== 'expired')
  ) {
    return null;
  }
  return {
    id,
    occ_symbol: r.occ_symbol,
    ticker: r.ticker,
    expiry: r.expiry,
    strike,
    side: r.side,
    direction: r.direction,
    entry_price: entryPrice,
    quantity,
    status: r.status,
    notes: typeof r.notes === 'string' ? r.notes : null,
    closed_at: toNullableString(r.closed_at),
    closed_price: toNullableString(r.closed_price),
    up_thresholds: toThresholds(r.up_thresholds),
    down_thresholds: toThresholds(r.down_thresholds),
    spot_alerts: toSpotAlerts(r.spot_alerts),
    // Display-only timestamps — ArchiveStats already guards these with
    // `Number.isFinite(new Date(...).getTime())`, so a missing value
    // degrades to "no hold-days data" rather than dropping the row.
    created_at: typeof r.created_at === 'string' ? r.created_at : '',
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
    latest_last: toNullableString(r.latest_last),
    latest_bid: toNullableString(r.latest_bid),
    latest_ask: toNullableString(r.latest_ask),
    latest_underlying: toNullableString(r.latest_underlying),
    latest_fetched_at: toNullableString(r.latest_fetched_at),
  };
}

/**
 * Validate the list envelope. Returns the surviving rows, or `null` when
 * the body isn't a contracts payload at all — the caller then throws
 * into its existing error path instead of putting `undefined` in state.
 */
function validateContractList(raw: unknown): TrackerContract[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.contracts)) return null;
  const out: TrackerContract[] = [];
  for (const row of r.contracts) {
    const valid = validateContract(row);
    if (valid) out.push(valid);
  }
  return out;
}

interface CreateResponse {
  contract: TrackerContract;
}

interface UpdateResponse {
  contract: TrackerContract;
}

interface ErrorResponse {
  error: string;
  occ_symbol?: string;
}

const POLL_INTERVAL_MS = 30_000;

export interface UseTrackerContractsArgs {
  status: ContractStatus;
  enabled?: boolean;
  marketOpen?: boolean;
}

export interface UseTrackerContractsState {
  data: TrackerContract[];
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  refresh: () => Promise<void>;
  mutate: (patch: (prev: TrackerContract[]) => TrackerContract[]) => void;
  create: (
    body: ContractCreateInput | ContractFreeTextInput,
  ) => Promise<TrackerContract>;
  update: (id: number, body: ContractUpdateInput) => Promise<TrackerContract>;
  close: (id: number, closedPrice: number) => Promise<TrackerContract>;
}

async function postJson<TResp>(
  url: string,
  body: unknown,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<TResp> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : ({} as unknown);
  if (!res.ok) {
    const errBody = json as ErrorResponse;
    throw new Error(errBody.error ?? `HTTP ${res.status}`);
  }
  return json as TResp;
}

export function useTrackerContracts({
  status,
  enabled = true,
  marketOpen = false,
}: UseTrackerContractsArgs): UseTrackerContractsState {
  const [data, setData] = useState<TrackerContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(
        `/api/tracker/contracts?status=${encodeURIComponent(status)}`,
        { credentials: 'include', signal: ctrl.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contracts = validateContractList(await res.json());
      if (ctrl.signal.aborted) return;
      if (contracts === null) throw new Error('Unexpected response shape');
      setData(contracts);
      setError(null);
      setFetchedAt(Date.now());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (ctrl.signal.aborted) return;
      setError(getErrorMessage(err));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [status]);

  // Eager mount fetch — usePolling only schedules the recurring tick.
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh();
  }, [enabled, refresh]);

  usePolling(refresh, POLL_INTERVAL_MS, [enabled, marketOpen]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const mutate = useCallback(
    (patch: (prev: TrackerContract[]) => TrackerContract[]) => {
      setData((prev) => patch(prev));
    },
    [],
  );

  const create = useCallback(
    async (body: ContractCreateInput | ContractFreeTextInput) => {
      const json = await postJson<CreateResponse>(
        '/api/tracker/contracts',
        body,
      );
      // Validate before the optimistic insert — a malformed row put into
      // state crashes the table render on the very next frame, which is
      // worse than surfacing the failure to the caller's catch.
      const contract = validateContract(json.contract);
      if (contract === null) throw new Error('Unexpected response shape');
      // Optimistic insert so the row appears immediately even before a
      // refresh lands. Status mismatches are filtered out (e.g. a closed
      // row should not appear on the Active tab).
      if (contract.status === status) {
        mutate((prev) => [...prev, contract]);
      }
      return contract;
    },
    [status, mutate],
  );

  const update = useCallback(
    async (id: number, body: ContractUpdateInput) => {
      const json = await postJson<UpdateResponse>(
        `/api/tracker/contracts/${String(id)}`,
        body,
        'PATCH',
      );
      const contract = validateContract(json.contract);
      if (contract === null) throw new Error('Unexpected response shape');
      // If the patched row no longer matches the active filter (e.g.
      // status flipped to 'closed' on the Active tab) drop it from
      // local state. Otherwise replace in place.
      mutate((prev) => {
        if (contract.status !== status) {
          return prev.filter((c) => c.id !== id);
        }
        return prev.map((c) => (c.id === id ? contract : c));
      });
      return contract;
    },
    [status, mutate],
  );

  const close = useCallback(
    async (id: number, closedPrice: number) => {
      return update(id, { status: 'closed', closed_price: closedPrice });
    },
    [update],
  );

  return useMemo(
    () => ({
      data,
      loading,
      error,
      fetchedAt,
      refresh,
      mutate,
      create,
      update,
      close,
    }),
    [data, loading, error, fetchedAt, refresh, mutate, create, update, close],
  );
}
