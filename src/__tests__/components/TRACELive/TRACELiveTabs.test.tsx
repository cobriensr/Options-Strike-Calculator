import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TRACELiveTabs from '../../../components/TRACELive/TRACELiveTabs';

describe('TRACELiveTabs', () => {
  it('renders three tab buttons in canonical order: Gamma, Charm, Delta', () => {
    render(<TRACELiveTabs activeChart="gamma" onSelect={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent('Gamma');
    expect(tabs[1]).toHaveTextContent('Charm');
    expect(tabs[2]).toHaveTextContent('Delta');
  });

  it('marks the active tab with aria-selected=true', () => {
    render(<TRACELiveTabs activeChart="charm" onSelect={() => {}} />);
    const charmTab = screen.getByRole('tab', { name: /Charm/ });
    const gammaTab = screen.getByRole('tab', { name: /Gamma/ });
    expect(charmTab).toHaveAttribute('aria-selected', 'true');
    expect(gammaTab).toHaveAttribute('aria-selected', 'false');
  });

  it('fires onSelect with the right chart key when a tab is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TRACELiveTabs activeChart="gamma" onSelect={onSelect} />);
    await user.click(screen.getByRole('tab', { name: /Delta/ }));
    expect(onSelect).toHaveBeenCalledWith('delta');
    await user.click(screen.getByRole('tab', { name: /Charm/ }));
    expect(onSelect).toHaveBeenCalledWith('charm');
  });

  it('wires aria-controls / id pairing for screen readers', () => {
    render(<TRACELiveTabs activeChart="gamma" onSelect={() => {}} />);
    const gammaTab = screen.getByRole('tab', { name: /Gamma/ });
    expect(gammaTab).toHaveAttribute('aria-controls', 'trace-live-tab-gamma');
    expect(gammaTab).toHaveAttribute('id', 'trace-live-tab-gamma-btn');
  });

  it('uses role=tablist on the container', () => {
    render(<TRACELiveTabs activeChart="gamma" onSelect={() => {}} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });
});
