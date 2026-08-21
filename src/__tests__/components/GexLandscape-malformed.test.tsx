/**
 * GexLandscape × malformed /api/gex-landscape payload — crash regression.
 *
 * Unlike GexLandscape.test.tsx (which mocks useGexLandscapeData), this file
 * renders the REAL component + REAL data/scrub hooks with only `fetch`
 * mocked, because the production crash lived in the seam between them:
 *
 * A shapeless response body (`{}`, an HTML error page parsed loosely, a
 * 5xx JSON blob) made the hook fabricate a fresh `[]` for `timestamps` on
 * every render. The component mirrors `timestamps` into local state via an
 * effect keyed on that reference, so each fresh `[]` re-fired the effect →
 * setState → re-render → another fresh `[]` → "Maximum update depth
 * exceeded" (2,300+ console errors in seconds), with the section
 * ErrorBoundary remounting the panel straight back into the same loop.
 *
 * Contract under test: on a malformed payload the panel settles into its
 * normal error/empty state with ZERO console errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { MockInstance } from 'vitest';
import GexLandscape from '../../components/GexLandscape';
import { CollapseAllContext } from '../../components/collapse-context';
import type { CollapseSignal } from '../../components/collapse-context';

vi.mock('../../utils/auth', () => ({
  getAccessMode: () => 'owner',
  checkIsOwner: () => true,
}));

const collapseSignal: CollapseSignal = { version: 0, collapsed: false };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderLandscape() {
  return render(
    <CollapseAllContext.Provider value={collapseSignal}>
      <GexLandscape marketOpen={true} />
    </CollapseAllContext.Provider>,
  );
}

describe('GexLandscape — malformed payload crash regression', () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('settles into the error state on a shapeless {} payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );

    renderLandscape();

    await waitFor(() =>
      expect(
        screen.getByText(/unexpected response shape/i),
      ).toBeInTheDocument(),
    );

    // The pre-fix behavior flooded console.error with "Maximum update
    // depth exceeded" — the settled state must produce none at all.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('settles into the empty state on a valid-but-empty payload with zero console errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          marketOpen: true,
          asOf: '2026-05-26T18:40:00.000Z',
          data: null,
          reason: 'no_slot',
          availableMinutes: [],
        }),
      ),
    );

    renderLandscape();

    await waitFor(() =>
      expect(screen.getByText(/no strike data available/i)).toBeInTheDocument(),
    );

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
