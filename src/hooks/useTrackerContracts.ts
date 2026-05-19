/**
 * useTrackerContracts — fetches /api/tracker/contracts for a given
 * status filter plus exposes CRUD helpers.
 *
 * Returns the existing-hook contract:
 *   `{ data, loading, error, refetch, mutate }`
 *
 * `mutate` is a synchronous client-side patch for optimistic updates
 * (e.g. closing a row); the caller is responsible for following up with
 * `refetch()` after the server PATCH resolves.
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
  TrackerContract,
} from '../components/Tracker/types.js';
import { usePolling } from './usePolling.js';
import { getErrorMessage } from '../utils/error.js';

interface ListResponse {
  contracts: TrackerContract[];
  count: number;
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
  refetch: () => Promise<void>;
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

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(
        `/api/tracker/contracts?status=${encodeURIComponent(status)}`,
        { credentials: 'include', signal: ctrl.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ListResponse;
      if (ctrl.signal.aborted) return;
      setData(json.contracts);
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
    refetch();
  }, [enabled, refetch]);

  usePolling(refetch, POLL_INTERVAL_MS, [enabled, marketOpen]);

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
      // Optimistic insert so the row appears immediately even before a
      // refetch lands. Status mismatches are filtered out (e.g. a closed
      // row should not appear on the Active tab).
      if (json.contract.status === status) {
        mutate((prev) => [...prev, json.contract]);
      }
      return json.contract;
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
      // If the patched row no longer matches the active filter (e.g.
      // status flipped to 'closed' on the Active tab) drop it from
      // local state. Otherwise replace in place.
      mutate((prev) => {
        if (json.contract.status !== status) {
          return prev.filter((c) => c.id !== id);
        }
        return prev.map((c) => (c.id === id ? json.contract : c));
      });
      return json.contract;
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
      refetch,
      mutate,
      create,
      update,
      close,
    }),
    [data, loading, error, fetchedAt, refetch, mutate, create, update, close],
  );
}
