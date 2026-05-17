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

  it('excludes the results panel from the togglable list', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    expect(screen.queryByText('Results')).toBeNull();
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

  it('reset button disabled when no panels hidden', () => {
    render(
      <PanelPrefsModal
        isOpen
        onClose={() => undefined}
        panelPrefs={makePrefs()}
        isAuthenticated
        hasMarketOrSnapshot
      />,
    );
    const resetBtn = screen.getByRole('button', { name: /Reset/ });
    expect(resetBtn).toBeDisabled();
  });

  it('reset button calls panelPrefs.reset when enabled', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    expect(prefs.reset).toHaveBeenCalledTimes(1);
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
