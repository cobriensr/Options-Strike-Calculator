/**
 * usePanelPrefs × malformed GET /api/panel-prefs payload — crash
 * regression (client-shape-hardening-2026-08-20 follow-up).
 *
 * Unlike PanelPrefsModal.test.tsx (which hands the modal a hand-built
 * `PanelPrefs` object), this file renders the REAL modal + REAL
 * usePanelPrefs with only `fetch` stubbed, because the blast radius of a
 * malformed prefs payload is the layout itself: the hook fed
 * `data.panelOrder` / `data.groupOrder` straight into state, and both
 * App.tsx and this modal iterate them via `resolvePanelOrder` /
 * `resolveGroupOrder` (`for (const id of stored)`). A non-iterable value
 * there throws during render — which blanks the whole page, not one
 * panel.
 *
 * The modal is used as the render surface because it exercises the exact
 * same two resolvers App.tsx does, without App's fetch fan-out.
 *
 * Contract under test: a malformed envelope leaves the localStorage-seeded
 * (or default) layout intact, renders every group, writes no garbage back
 * to localStorage, and logs ZERO console errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MockInstance } from 'vitest';

vi.mock('../../utils/auth', () => ({
  getAccessMode: () => 'owner',
  checkIsOwner: () => true,
}));

import { usePanelPrefs } from '../../hooks/usePanelPrefs';
import { PanelPrefsModal } from '../../components/PanelPrefsModal/PanelPrefsModal';

const STORAGE_KEY = 'sc-panel-prefs-v1';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(payload)),
  );
}

/**
 * Real hook → real modal. Mirrors App.tsx's wiring (`usePanelPrefs()`
 * threaded straight into the modal prop).
 */
function Harness() {
  const panelPrefs = usePanelPrefs();
  return (
    <>
      {/* `isLoaded` flips true only after the GET has resolved AND its
          axes have been applied — awaiting this marker makes the
          localStorage assertions below deterministic instead of racing
          the fetch. */}
      {panelPrefs.isLoaded && <div data-testid="prefs-loaded" />}
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={panelPrefs}
        isAuthenticated
        hasMarketOrSnapshot
      />
    </>
  );
}

function readStored(): unknown {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw == null ? null : JSON.parse(raw);
}

describe('usePanelPrefs — malformed payload crash regression', () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    window.localStorage.clear();
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the full layout on a shapeless {} payload with zero console errors', async () => {
    stubFetch({});

    render(<Harness />);

    expect(await screen.findByTestId('prefs-loaded')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Inputs')).toBeInTheDocument();
    expect(screen.getByText('Market Context')).toBeInTheDocument();
    expect(screen.getByText('Trading')).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renders the full layout on an HTML-ish string body with zero console errors', async () => {
    stubFetch('<!doctype html><html>oops</html>');

    render(<Harness />);

    expect(await screen.findByTestId('prefs-loaded')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Market Context')).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('does not blank the layout when panelOrder/groupOrder are non-iterable', async () => {
    // The dangerous partial: a valid `hiddenPanels` gets past the first
    // axis check, then a non-array order axis reaches
    // resolvePanelOrder's `for (const id of stored)`.
    stubFetch({
      hiddenPanels: ['sec-darkpool'],
      panelOrder: { bogus: 1 },
      groupOrder: 42,
    });

    render(<Harness />);

    expect(await screen.findByTestId('prefs-loaded')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Every group still renders — the malformed order axes are ignored,
    // not applied.
    expect(screen.getByText('Inputs')).toBeInTheDocument();
    expect(screen.getByText('Market Context')).toBeInTheDocument();
    expect(screen.getByText('Trading')).toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('ignores a non-array hiddenPanels instead of hiding character-keyed panels', async () => {
    // `new Set('sec-darkpool')` would produce a Set of single characters
    // — harmless-looking but it poisons localStorage on the mirror
    // effect and makes `hidden.size` lie.
    stubFetch({ hiddenPanels: 'sec-darkpool' });

    render(<Harness />);

    expect(await screen.findByTestId('prefs-loaded')).toBeInTheDocument();
    const stored = readStored() as { hiddenPanels: string[] } | null;
    expect(stored?.hiddenPanels ?? []).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('applies the valid axes of a partially-malformed payload', async () => {
    stubFetch({
      hiddenPanels: ['sec-darkpool', 42, null],
      panelOrder: ['sec-iv', {}],
      groupOrder: 'nope',
    });

    render(<Harness />);

    expect(await screen.findByTestId('prefs-loaded')).toBeInTheDocument();
    const stored = readStored() as {
      hiddenPanels: string[];
      panelOrder: string[];
      groupOrder: string[];
    } | null;
    // Valid entries survive; malformed entries are dropped, and the
    // wholly-malformed groupOrder axis never lands in state.
    expect(stored?.hiddenPanels).toEqual(['sec-darkpool']);
    expect(stored?.panelOrder).toEqual(['sec-iv']);
    expect(stored?.groupOrder).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('keeps the localStorage seed when the server payload is malformed', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        hiddenPanels: ['sec-greek-flow'],
        panelOrder: ['sec-iv'],
        groupOrder: ['Trading'],
      }),
    );
    stubFetch({});

    render(<Harness />);

    expect(await screen.findByTestId('prefs-loaded')).toBeInTheDocument();
    const stored = readStored() as {
      hiddenPanels: string[];
      panelOrder: string[];
      groupOrder: string[];
    } | null;
    expect(stored?.hiddenPanels).toEqual(['sec-greek-flow']);
    expect(stored?.panelOrder).toEqual(['sec-iv']);
    expect(stored?.groupOrder).toEqual(['Trading']);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
