/**
 * usePyramidData — data layer for the Pyramid Trade Tracker experiment.
 *
 * Per spec (docs/superpowers/specs/pyramid-tracker-2026-04-16.md) this is a
 * single-owner tool: there is one dataset (the owner's chains + legs), no
 * arguments, no polling. Fetches chains + progress counts on mount; mutation
 * helpers revalidate both after every successful write.
 *
 * Error model: every endpoint that returns a non-2xx status (or rejects at
 * the network layer) surfaces as a thrown `PyramidApiError` with:
 *   - `status`  — HTTP status code (0 for network failures)
 *   - `code`    — server-supplied machine code (e.g. `'leg_1_missing'`)
 *   - `message` — human-readable message
 *
 * Callers that need to branch on the error type should use `instanceof
 * PyramidApiError` and inspect `status` / `code`. The typical branches are:
 *   - 401 → owner-only message
 *   - 409 with code `'leg_1_missing'` → "log leg 1 first" hint
 *   - 400 → render the validation message inline
 *   - 500+ / network → "server error, try again"
 *
 * Initial load errors populate `error` on the hook state. Mutation errors
 * are thrown to the caller (form-level try/catch) and also update `error`
 * for the container-level error state.
 *
 * No SWR / react-query by design — matches existing hooks like
 * `useMarketData` and `useChainData`. `credentials: 'include'` sends the
 * owner cookie to every endpoint.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PyramidChain,
  PyramidChainInput,
  PyramidChainWithLegs,
  PyramidLeg,
  PyramidLegInput,
  PyramidProgress,
} from '../types/pyramid';
import { getErrorMessage } from '../utils/error';

// ============================================================
// Error class
// ============================================================

/**
 * Thrown by every mutation + by the initial load when an endpoint returns a
 * non-2xx status or the fetch itself fails. `instanceof PyramidApiError`
 * works normally because the class sets its prototype (required so
 * downlevel-compiled `extends Error` preserves the prototype chain).
 */
export class PyramidApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'PyramidApiError';
    this.status = status;
    this.code = code;
    // Re-establish the prototype chain so `instanceof` works even when the
    // class is extended or this file is compiled to ES5.
    Object.setPrototypeOf(this, PyramidApiError.prototype);
  }
}

// ============================================================
// Fetch helper
// ============================================================

/**
 * Minimal typed fetch wrapper used by every hook method.
 *
 * Success (2xx): parses JSON and returns it as `T`.
 * Failure: throws `PyramidApiError`. For non-2xx responses it tries to
 * read the JSON body to extract `{ error: string }` (the standard shape
 * returned by the pyramid endpoints — see `api/pyramid/*.ts`).
 *
 * Network failures (fetch rejection) become `PyramidApiError` with
 * `status: 0` so callers can still branch uniformly.
 */
async function pyramidFetch<T>(
  url: string,
  init?: RequestInit & { jsonBody?: unknown },
): Promise<T> {
  const { jsonBody, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  if (jsonBody !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      credentials: 'include',
      headers,
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : rest.body,
    });
  } catch (err) {
    throw new PyramidApiError(
      `Network error: ${getErrorMessage(err)}`,
      0,
      'network_error',
    );
  }

  if (res.ok) {
    // DELETE returns `{ ok: true }`; callers that only care about success
    // can ignore the payload. Cast the parsed body to T either way.
    return (await res.json()) as T;
  }

  // Non-2xx: parse error body if possible so we can surface a code.
  let code: string | undefined;
  let message = `Request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === 'string' && body.error.length > 0) {
      code = body.error;
      message = body.error;
    }
  } catch {
    // Non-JSON body — keep the generic message.
  }

  if (res.status === 401) {
    message = 'Owner access required';
  }
  throw new PyramidApiError(message, res.status, code);
}

// ============================================================
// Hook return shape
// ============================================================

export interface UsePyramidDataReturn {
  chains: PyramidChain[];
  progress: PyramidProgress | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch chains + progress. Safe to call at any time. */
  refresh: () => Promise<void>;
  createChain: (input: PyramidChainInput) => Promise<PyramidChain>;
  updateChain: (
    id: string,
    patch: Partial<PyramidChainInput>,
  ) => Promise<PyramidChain>;
  deleteChain: (id: string) => Promise<void>;
  getChainWithLegs: (id: string) => Promise<PyramidChainWithLegs>;
  createLeg: (input: PyramidLegInput) => Promise<PyramidLeg>;
  updateLeg: (
    id: string,
    patch: Partial<PyramidLegInput>,
  ) => Promise<PyramidLeg>;
  deleteLeg: (id: string) => Promise<void>;
}

// ============================================================
// Hook
// ============================================================

export function usePyramidData(): UsePyramidDataReturn {
  const [chains, setChains] = useState<PyramidChain[]>([]);
  const [progress, setProgress] = useState<PyramidProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // StrictMode double-mounts in dev fire two initial loads; the ref is used
  // by the mount effect's cleanup to drop stale results if the component
  // unmounts mid-fetch (avoids "Can't perform state update on unmounted
  // component" warnings in tests).
  const mountedRef = useRef(true);
  // Monotonic id for in-flight refresh() calls. Every invocation increments
  // the counter and captures its own id; state updates are dropped when a
  // newer refresh has started, so overlapping revalidations (e.g. two rapid
  // mutations each firing `void refresh()`) can't clobber the newer result
  // with an older response. `mountedRef` guards against unmount; this guards
  // against stale-overwrite — both are needed.
  const reqIdRef = useRef(0);

  /**
   * Fetch `/api/pyramid/chains` + `/api/pyramid/progress` in parallel.
   * Success: clears `error` and updates both state slots. Failure: sets
   * `error` with a user-facing message. Never throws — `refresh` is safe
   * to call without a try/catch from UI handlers.
   *
   * Race model: each call grabs a request id; if a newer call started
   * while this one was awaiting, every state write is skipped. The newer
   * call owns the final state. This matches how SWR/react-query handle
   * revalidation ordering without their machinery.
   */
  const refresh = useCallback(async () => {
    reqIdRef.current += 1;
    const myId = reqIdRef.current;
    setLoading(true);
    try {
      const [chainsResult, progressResult] = await Promise.all([
        pyramidFetch<{ chains: PyramidChain[] }>('/api/pyramid/chains'),
        pyramidFetch<PyramidProgress>('/api/pyramid/progress'),
      ]);
      if (!mountedRef.current || myId !== reqIdRef.current) return;
      setChains(chainsResult.chains);
      setProgress(progressResult);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || myId !== reqIdRef.current) return;
      if (err instanceof PyramidApiError) {
        setError(err.message);
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      if (mountedRef.current && myId === reqIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  /**
   * Run a mutation and re-load chains + progress on success. The mutation
   * result is returned to the caller; any thrown error propagates as-is
   * (intentionally — form components need to show inline errors).
   */
  const withRevalidation = useCallback(
    async <T>(mutation: () => Promise<T>): Promise<T> => {
      const result = await mutation();
      // Fire-and-forget revalidate. If it fails, `error` is updated via the
      // refresh's internal catch. The mutation itself already succeeded, so
      // we don't want to throw from here.
      void refresh();
      return result;
    },
    [refresh],
  );

  const createChain = useCallback(
    (input: PyramidChainInput) =>
      withRevalidation(() =>
        pyramidFetch<PyramidChain>('/api/pyramid/chains', {
          method: 'POST',
          jsonBody: input,
        }),
      ),
    [withRevalidation],
  );

  const updateChain = useCallback(
    (id: string, patch: Partial<PyramidChainInput>) =>
      withRevalidation(() =>
        pyramidFetch<PyramidChain>(
          `/api/pyramid/chains?id=${encodeURIComponent(id)}`,
          { method: 'PATCH', jsonBody: patch },
        ),
      ),
    [withRevalidation],
  );

  const deleteChain = useCallback(
    (id: string) =>
      withRevalidation(() =>
        pyramidFetch<{ ok: true }>(
          `/api/pyramid/chains?id=${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        ),
      ).then(() => undefined),
    [withRevalidation],
  );

  const getChainWithLegs = useCallback(
    (id: string) =>
      pyramidFetch<PyramidChainWithLegs>(
        `/api/pyramid/chains?id=${encodeURIComponent(id)}`,
      ),
    [],
  );

  const createLeg = useCallback(
    (input: PyramidLegInput) =>
      withRevalidation(() =>
        pyramidFetch<PyramidLeg>('/api/pyramid/legs', {
          method: 'POST',
          jsonBody: input,
        }),
      ),
    [withRevalidation],
  );

  const updateLeg = useCallback(
    (id: string, patch: Partial<PyramidLegInput>) =>
      withRevalidation(() =>
        pyramidFetch<PyramidLeg>(
          `/api/pyramid/legs?id=${encodeURIComponent(id)}`,
          { method: 'PATCH', jsonBody: patch },
        ),
      ),
    [withRevalidation],
  );

  const deleteLeg = useCallback(
    (id: string) =>
      withRevalidation(() =>
        pyramidFetch<{ ok: true }>(
          `/api/pyramid/legs?id=${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        ),
      ).then(() => undefined),
    [withRevalidation],
  );

  return {
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
  };
}
