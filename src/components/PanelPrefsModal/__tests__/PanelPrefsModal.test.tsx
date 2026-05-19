import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelPrefsModal } from '../PanelPrefsModal';
import type { PanelPrefs } from '../../../hooks/usePanelPrefs';

function makePrefs(hidden: string[] = []): PanelPrefs {
  const set = new Set(hidden);
  return {
    hidden: set,
    isHidden: (id) => set.has(id),
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

describe('PanelPrefsModal', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <PanelPrefsModal
        isOpen={false}
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders panels grouped by category when open', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Inputs')).toBeInTheDocument();
    expect(screen.getByText('Market Context')).toBeInTheDocument();
    expect(screen.getByText('Trading')).toBeInTheDocument();
    expect(screen.getByText('Date & Time')).toBeInTheDocument();
  });

  it('includes the results panel in the togglable list', () => {
    // Reverted from a prior "exclude results" filter so users can hide
    // the strike-calculator output if they're monitoring-only. The
    // Results panel is registered like every other entry now, which
    // means "Results" appears twice in the modal: once as the group
    // heading and once as the panel row.
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    const matches = screen.getAllByText('Results');
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('hides authenticated-only panels for a public visitor', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated={false}
        hasMarketOrSnapshot={false}
      />,
    );
    expect(screen.getByText('Date & Time')).toBeInTheDocument();
    expect(screen.getByText('Analysis History')).toBeInTheDocument();
    expect(screen.queryByText('Dark Pool Levels')).toBeNull();
    expect(screen.queryByText('Futures Calculator')).toBeNull();
    expect(screen.queryByText('BWB Calculator')).toBeNull();
  });

  it('checkbox state reflects hidden status (inverted)', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs(['sec-darkpool'])}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    const darkpoolCheckbox = screen.getByRole('checkbox', {
      name: /Show Dark Pool Levels/,
    });
    expect(darkpoolCheckbox).not.toBeChecked();
    const datetimeCheckbox = screen.getByRole('checkbox', {
      name: /Hide Date & Time/,
    });
    expect(datetimeCheckbox).toBeChecked();
  });

  it('toggle calls panelPrefs.toggle with the panel id', () => {
    const prefs = makePrefs();
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={prefs}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Hide Date & Time/ }));
    expect(prefs.toggle).toHaveBeenCalledWith('sec-datetime');
  });

  it('Reset visibility button disabled when no panels hidden', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Reset visibility' }),
    ).toBeDisabled();
  });

  it('Reset visibility calls panelPrefs.reset when enabled', () => {
    const prefs = makePrefs(['sec-darkpool']);
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={prefs}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset visibility' }));
    expect(prefs.reset).toHaveBeenCalledTimes(1);
  });

  it('Reset panel order calls panelPrefs.resetPanelOrder when enabled', () => {
    const prefs = makePrefs();
    prefs.order = ['sec-spot-price', 'sec-datetime'];
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={prefs}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    const btn = screen.getByRole('button', { name: 'Reset panel order' });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(prefs.resetPanelOrder).toHaveBeenCalledTimes(1);
  });

  it('Reset panel order disabled when stored order is empty', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Reset panel order' }),
    ).toBeDisabled();
  });

  it('Reset group order calls panelPrefs.resetGroupOrder when enabled', () => {
    const prefs = makePrefs();
    prefs.groupOrder = ['Trading', 'Inputs'];
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={prefs}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    const btn = screen.getByRole('button', { name: 'Reset group order' });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(prefs.resetGroupOrder).toHaveBeenCalledTimes(1);
  });

  it('Reset group order disabled when stored group order is empty', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Reset group order' }),
    ).toBeDisabled();
  });

  it('renders a drag handle button per panel row', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    // The grip handle has aria-label "Drag to reorder <panel label>"
    expect(
      screen.getByRole('button', { name: /Drag to reorder Date & Time/ }),
    ).toBeInTheDocument();
  });

  it('renders a drag handle button per group header', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    expect(
      screen.getByRole('button', { name: /Drag to reorder group Inputs/ }),
    ).toBeInTheDocument();
  });

  it('Done button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <PanelPrefsModal
        isOpen
        onClose={onClose}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape key closes the modal', () => {
    const onClose = vi.fn();
    render(
      <PanelPrefsModal
        isOpen
        onClose={onClose}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows visible/total count in the header', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs(['sec-darkpool', 'sec-greek-flow'])}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    expect(screen.getByText(/visible$/)).toHaveTextContent(
      /^\d{1,3}\/\d{1,3} visible$/,
    );
  });
});
