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

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PanelPrefs } from '../../../hooks/usePanelPrefs';

let loads = 0;
let failImport = false;

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

beforeEach(() => {
  loads = 0;
  failImport = false;
  vi.resetModules();
  vi.doMock('../PanelPrefsModal', async (importOriginal) => {
    loads += 1;
    if (failImport) throw new Error('chunk failed to load');
    return importOriginal();
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
        hasMarketOrSnapshot
      />,
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Show / Hide / Reorder Panels' }),
    ).toBeInTheDocument();
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
        hasMarketOrSnapshot
      />,
    );
    await screen.findByRole('dialog');
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
    await screen.findByRole('dialog');
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
          hasMarketOrSnapshot
        />
      </>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Panel preferences failed to render.',
    );
    expect(screen.getByText('page content')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(loads).toBe(1);
  });
});
