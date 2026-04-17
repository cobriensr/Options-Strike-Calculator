import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PyramidTrackerSection from '../../../components/PyramidTracker/PyramidTrackerSection';

// ============================================================
// HELPERS
// ============================================================

function mockFetchOk(body: unknown) {
  const fn = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * Route-aware fetch mock: different status/body per URL substring. Unlike
 * the hook test's helper, this variant is single-fire (no per-URL queue)
 * since the component tests only need one round-trip per endpoint.
 */
function mockFetchByUrl(
  responses: Record<string, { status: number; body: unknown }>,
) {
  const fn = vi.fn((url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    const matchedKey = Object.keys(responses).find((k) => u.includes(k));
    if (!matchedKey) {
      return Promise.reject(new Error(`unexpected fetch to ${u}`));
    }
    const { status, body } = responses[matchedKey]!;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  // Default to enabled — individual tests override.
  vi.stubEnv('VITE_PYRAMID_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ============================================================
// TESTS
// ============================================================

describe('PyramidTrackerSection', () => {
  it('renders nothing when VITE_PYRAMID_ENABLED is not "true"', () => {
    vi.stubEnv('VITE_PYRAMID_ENABLED', 'false');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { container } = render(<PyramidTrackerSection />);

    expect(container.firstChild).toBeNull();
    // Kill switch must fire before the hook runs — no fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders collapsed by default when enabled', async () => {
    mockFetchOk({ chains: [] });
    // Fresh mock for each URL so the second progress call doesn't collide.
    mockFetchByUrl({
      '/api/pyramid/chains': { status: 200, body: { chains: [] } },
      '/api/pyramid/progress': {
        status: 200,
        body: {
          total_chains: 0,
          chains_by_day_type: {
            trend: 0,
            chop: 0,
            news: 0,
            mixed: 0,
            unspecified: 0,
          },
          elapsed_calendar_days: null,
          fill_rates: {},
        },
      },
    });

    render(<PyramidTrackerSection />);

    const toggle = await screen.findByRole('button', {
      name: /Pyramid Trade Tracker/i,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Content placeholder is not in the DOM when collapsed.
    expect(screen.queryByTestId('pyramid-tracker-content')).toBeNull();
  });

  it('expands on button click and updates aria-expanded / aria-controls', async () => {
    mockFetchByUrl({
      '/api/pyramid/chains': { status: 200, body: { chains: [] } },
      '/api/pyramid/progress': {
        status: 200,
        body: {
          total_chains: 0,
          chains_by_day_type: {
            trend: 0,
            chop: 0,
            news: 0,
            mixed: 0,
            unspecified: 0,
          },
          elapsed_calendar_days: null,
          fill_rates: {},
        },
      },
    });

    render(<PyramidTrackerSection />);

    const toggle = await screen.findByRole('button', {
      name: /Pyramid Trade Tracker/i,
    });
    // aria-controls must reference the content container's id.
    const controlsId = toggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const content = document.getElementById(controlsId!);
    expect(content).not.toBeNull();
    expect(content).toHaveAttribute('data-testid', 'pyramid-tracker-content');
  });

  it('shows loading state while data resolves and clears it after', async () => {
    // Hold the fetch promises open so we can assert the loading state.
    const pendingResolvers: Array<(value: unknown) => void> = [];
    globalThis.fetch = vi.fn(() =>
      new Promise((resolve) => {
        pendingResolvers.push(resolve);
      }).then(() => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            chains: [],
            total_chains: 0,
            chains_by_day_type: {
              trend: 0,
              chop: 0,
              news: 0,
              mixed: 0,
              unspecified: 0,
            },
            elapsed_calendar_days: null,
            fill_rates: {},
          }),
      })),
    ) as unknown as typeof fetch;

    render(<PyramidTrackerSection />);

    const toggle = await screen.findByRole('button', {
      name: /Pyramid Trade Tracker/i,
    });
    await userEvent.click(toggle);

    // While fetches are pending, the loading indicator is visible.
    expect(screen.getByRole('status')).toHaveTextContent(/Loading pyramid/i);

    // Resolve all pending fetches.
    for (const resolve of pendingResolvers) resolve(undefined);

    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  it('shows owner-required message on 401 when expanded', async () => {
    mockFetchByUrl({
      '/api/pyramid/chains': {
        status: 401,
        body: { error: 'Unauthorized' },
      },
      '/api/pyramid/progress': {
        status: 401,
        body: { error: 'Unauthorized' },
      },
    });

    render(<PyramidTrackerSection />);

    const toggle = await screen.findByRole('button', {
      name: /Pyramid Trade Tracker/i,
    });
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/owner access/i);
    });
    // No retry button on 401 — the user needs to authenticate, not retry.
    expect(
      screen.queryByRole('button', { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it('shows a retry button on non-401 error and re-fetches when clicked', async () => {
    // Initial load fails; retry succeeds.
    const fn = vi.fn((url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/pyramid/chains')) {
        // Fail once, then succeed.
        if (
          fn.mock.calls.filter((c) => String(c[0]).includes('chains'))
            .length === 1
        ) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: 'DB unreachable' }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ chains: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            total_chains: 0,
            chains_by_day_type: {
              trend: 0,
              chop: 0,
              news: 0,
              mixed: 0,
              unspecified: 0,
            },
            elapsed_calendar_days: null,
            fill_rates: {},
          }),
      });
    });
    globalThis.fetch = fn as unknown as typeof fetch;

    render(<PyramidTrackerSection />);
    const toggle = await screen.findByRole('button', {
      name: /Pyramid Trade Tracker/i,
    });
    await userEvent.click(toggle);

    const retry = await screen.findByRole('button', { name: /retry/i });
    await userEvent.click(retry);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
