/**
 * LazyPanelPrefsModal keeps PanelPrefsModal (and @dnd-kit) out of the
 * entry bundle by importing it only once the modal opens.
 *
 * React.lazy caches its module for the life of the module graph, so each
 * test resets modules, registers a fresh PanelPrefsModal mock with
 * vi.doMock and imports the wrapper anew. The mock wraps the real module
 * and counts imports, or rejects the import the way a chunk that failed to
 * load does. (Vitest wraps a factory's error, so the rejection is not the
 * browser's TypeError and handleStaleChunk skips its reload prompt; that
 * branch is covered by handle-stale-chunk.test.ts.)
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { PanelPrefs } from '../../../hooks/usePanelPrefs';

let loads = 0;
let failImport = false;
let importDelayMs = 0;
let factoryDone: Promise<void> = Promise.resolve();
let markFactoryDone = () => {};

// Opening imports the real PanelPrefsModal and @dnd-kit through the mock's
// importOriginal, and vi.resetModules() makes that a cold import every test.
// On a busy box it takes seconds, so a findBy* (1 s by default) races the
// import instead of observing it. Wait for the mock factory itself, which
// finishes exactly when the import does (or fails), then let React commit
// what the lazy boundary resolved; the queries after it are synchronous.
async function importSettled() {
  await act(async () => {
    await factoryDone;
    await vi.dynamicImportSettled();
  });
}

function makePrefs(): PanelPrefs {
  return {
    hidden: new Set(),
    isHidden: () => false,
    toggle: vi.fn(),
    reset: vi.fn(),
    order: [],
    setOrder: vi.fn(),
    resetPanelOrder: vi.fn(),
    groupOrder: [],
    setGroupOrder: vi.fn(),
    resetGroupOrder: vi.fn(),
    isLoaded: true,
  };
}

async function loadWrapper() {
  const { LazyPanelPrefsModal } = await import('../LazyPanelPrefsModal');
  return LazyPanelPrefsModal;
}

// The first import of the wrapper and the modal is a cold transform of the
// whole graph (React, @dnd-kit, the handlers): 8 s in a loaded baseline run
// and 19 s in a starved one, against the 15 s test timeout, and the first test
// is the one that paid it. Pay it here under its own timeout instead; later
// imports reuse the transformed modules.
beforeAll(async () => {
  await import('../LazyPanelPrefsModal');
  await import('../PanelPrefsModal');
}, 60_000);

beforeEach(() => {
  loads = 0;
  failImport = false;
  importDelayMs = 0;
  factoryDone = new Promise<void>((resolve) => {
    markFactoryDone = resolve;
  });
  vi.resetModules();
  vi.doMock('../PanelPrefsModal', async (importOriginal) => {
    loads += 1;
    try {
      if (failImport) throw new Error('chunk failed to load');
      if (importDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, importDelayMs));
      }
      return await importOriginal();
    } finally {
      markFactoryDone();
    }
  });
});

afterEach(() => {
  vi.doUnmock('../PanelPrefsModal');
  vi.restoreAllMocks();
});

describe('LazyPanelPrefsModal', () => {
  it('renders nothing and does not import the modal while closed', async () => {
    const LazyPanelPrefsModal = await loadWrapper();
    const { container } = render(
      <LazyPanelPrefsModal
        isOpen={false}
        onClose={vi.fn()}
        panelPrefs={makePrefs()}
        isAuthenticated
        isOwner={false}
        hasMarketOrSnapshot
      />,
    );
    // Let any import the render started finish before counting.
    await vi.dynamicImportSettled();
    expect(container).toBeEmptyDOMElement();
    expect(loads).toBe(0);
  });

  it('imports the modal on open and shows the dialog', async () => {
    const LazyPanelPrefsModal = await loadWrapper();
    render(
      <LazyPanelPrefsModal
        isOpen
        onClose={vi.fn()}
        panelPrefs={makePrefs()}
        isAuthenticated
        isOwner={false}
        hasMarketOrSnapshot
      />,
    );
    await importSettled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Show / Hide / Reorder Panels' }),
    ).toBeInTheDocument();
    expect(loads).toBe(1);
  });

  it('shows the dialog when the chunk takes longer than a findBy query waits', async () => {
    // A cold import on a busy box. 1.2 s is past findBy*'s 1 s default, so a
    // test that raced the import with one would fail here every time.
    importDelayMs = 1_200;
    const LazyPanelPrefsModal = await loadWrapper();
    render(
      <LazyPanelPrefsModal
        isOpen
        onClose={vi.fn()}
        panelPrefs={makePrefs()}
        isAuthenticated
        isOwner={false}
        hasMarketOrSnapshot
      />,
    );
    await importSettled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(loads).toBe(1);
  });

  it('passes props through: a checkbox toggles the panel and Done closes', async () => {
    const LazyPanelPrefsModal = await loadWrapper();
    const prefs = makePrefs();
    const onClose = vi.fn();
    render(
      <LazyPanelPrefsModal
        isOpen
        onClose={onClose}
        panelPrefs={prefs}
        isAuthenticated
        isOwner={false}
        hasMarketOrSnapshot
      />,
    );
    await importSettled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Hide Date & Time/ }));
    expect(prefs.toggle).toHaveBeenCalledWith('sec-datetime');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('unmounts on close and returns focus to the button that opened it', async () => {
    const LazyPanelPrefsModal = await loadWrapper();
    const props = {
      onClose: vi.fn(),
      panelPrefs: makePrefs(),
      isAuthenticated: true,
      isOwner: false,
      hasMarketOrSnapshot: true,
    };
    const page = (isOpen: boolean) => (
      <>
        <button type="button">gear</button>
        <LazyPanelPrefsModal isOpen={isOpen} {...props} />
      </>
    );
    const { rerender } = render(page(false));
    const gear = screen.getByRole('button', { name: 'gear' });
    gear.focus();

    rerender(page(true));
    await importSettled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();

    rerender(page(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(gear).toHaveFocus();
  });

  it('contains a failed chunk import to an inline error instead of blanking the page', async () => {
    // React and the ErrorBoundary log the caught error.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    failImport = true;
    const LazyPanelPrefsModal = await loadWrapper();
    render(
      <>
        <p>page content</p>
        <LazyPanelPrefsModal
          isOpen
          onClose={vi.fn()}
          panelPrefs={makePrefs()}
          isAuthenticated
          isOwner={false}
          hasMarketOrSnapshot
        />
      </>,
    );
    await importSettled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Panel preferences failed to render.',
    );
    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(loads).toBe(1);
  });
});
