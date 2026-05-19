import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFetchedData } from '../useFetchedData';

const URL = '/api/test-endpoint';

let fetchSpy: ReturnType<typeof vi.spyOn>;

function mockFetchOk(body: unknown): void {
  fetchSpy.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function mockFetchStatus(status: number): void {
  fetchSpy.mockImplementation(() =>
    Promise.resolve(new Response('error', { status })),
  );
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useFetchedData', () => {
  describe('initial state', () => {
    it('returns null data with loading=false when url is null', async () => {
      const { result } = renderHook(() =>
        useFetchedData<{ x: number }>({ url: null, marketOpen: true }),
      );
      expect(result.current.data).toBeNull();
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.fetchedAt).toBeNull();
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches on mount when url is set', async () => {
      mockFetchOk({ value: 42 });
      const { result } = renderHook(() =>
        useFetchedData<{ value: number }>({
          url: URL,
          marketOpen: false,
        }),
      );
      await waitFor(() => {
        expect(result.current.data).toEqual({ value: 42 });
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.fetchedAt).toBeGreaterThan(0);
    });
  });

  describe('parse', () => {
    it('applies a custom parse function returning a string', async () => {
      mockFetchOk({ raw: 'abc' });
      const { result } = renderHook(() =>
        useFetchedData<string>({
          url: URL,
          marketOpen: false,
          parse: (raw): string => (raw as { raw: string }).raw.toUpperCase(),
        }),
      );
      await waitFor(() => {
        expect(result.current.data).toBe('ABC');
      });
    });

    it('applies a custom parse function returning a number', async () => {
      mockFetchOk({ n: 41 });
      const { result } = renderHook(() =>
        useFetchedData<number>({
          url: URL,
          marketOpen: false,
          parse: (raw): number => (raw as { n: number }).n + 1,
        }),
      );
      await waitFor(() => {
        expect(result.current.data).toBe(42);
      });
    });

    it('applies a custom parse function returning an array', async () => {
      mockFetchOk({ xs: [1, 2, 3] });
      const { result } = renderHook(() =>
        useFetchedData<readonly number[]>({
          url: URL,
          marketOpen: false,
          parse: (raw): readonly number[] => (raw as { xs: number[] }).xs,
        }),
      );
      await waitFor(() => {
        expect(result.current.data).toEqual([1, 2, 3]);
      });
    });
  });

  describe('error handling', () => {
    it('surfaces non-2xx responses as an HTTP-status error string', async () => {
      mockFetchStatus(500);
      const { result } = renderHook(() =>
        useFetchedData<unknown>({ url: URL, marketOpen: false }),
      );
      await waitFor(() => {
        expect(result.current.error).toBe('HTTP 500');
      });
      expect(result.current.data).toBeNull();
      expect(result.current.loading).toBe(false);
    });
  });

  describe('refresh', () => {
    it('cancels in-flight and fires a fresh fetch with the new payload', async () => {
      mockFetchOk({ v: 1 });
      const { result } = renderHook(() =>
        useFetchedData<{ v: number }>({ url: URL, marketOpen: false }),
      );
      await waitFor(() => {
        expect(result.current.data).toEqual({ v: 1 });
      });
      const firstFetchedAt = result.current.fetchedAt;
      mockFetchOk({ v: 2 });
      const refresh = result.current.refresh;
      act(() => {
        refresh();
      });
      await waitFor(() => {
        expect(result.current.data).toEqual({ v: 2 });
      });
      expect(result.current.fetchedAt).not.toBe(firstFetchedAt);
    });

    it('does nothing when url is null', async () => {
      const { result } = renderHook(() =>
        useFetchedData<unknown>({ url: null, marketOpen: false }),
      );
      // result.current is captured before the act call so a microtask
      // between calls can't void it.
      const refresh = result.current.refresh;
      act(() => {
        refresh();
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('disabled → enabled transition', () => {
    it('starts fetching when url flips from null to a string', async () => {
      mockFetchOk({ v: 'b' });
      const { result, rerender } = renderHook(
        ({ url }) => useFetchedData<{ v: string }>({ url, marketOpen: false }),
        { initialProps: { url: null as string | null } },
      );
      // null url — no fetch yet.
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchSpy).not.toHaveBeenCalled();
      // Flip the url on. Eager fetch effect fires.
      rerender({ url: '/api/b' });
      await waitFor(() => {
        expect(result.current.data).toEqual({ v: 'b' });
      });
    });
  });
});
