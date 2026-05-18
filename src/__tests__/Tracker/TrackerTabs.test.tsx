import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrackerTabs } from '../../components/Tracker/TrackerTabs';
import type { TrackerTab } from '../../components/Tracker/TrackerTabs';

const counts: Record<TrackerTab, number> = {
  active: 5,
  watchlist: 2,
  archive: 17,
};

describe('TrackerTabs', () => {
  it('renders three tabs with their labels and counts', () => {
    render(
      <TrackerTabs
        current="active"
        onChange={() => undefined}
        counts={counts}
      />,
    );
    expect(screen.getByRole('tab', { name: /Active/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Watchlist/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Archive/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Active/ })).toHaveTextContent('5');
    expect(screen.getByRole('tab', { name: /Watchlist/ })).toHaveTextContent(
      '2',
    );
    expect(screen.getByRole('tab', { name: /Archive/ })).toHaveTextContent(
      '17',
    );
  });

  it('marks only the current tab as aria-selected', () => {
    render(
      <TrackerTabs
        current="watchlist"
        onChange={() => undefined}
        counts={counts}
      />,
    );
    expect(screen.getByRole('tab', { name: /Watchlist/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Active/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tab', { name: /Archive/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('calls onChange with the clicked tab name', () => {
    const onChange = vi.fn();
    render(
      <TrackerTabs current="active" onChange={onChange} counts={counts} />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Archive/ }));
    expect(onChange).toHaveBeenCalledWith('archive');
  });

  it('exposes tablist semantics for assistive tech', () => {
    render(
      <TrackerTabs
        current="active"
        onChange={() => undefined}
        counts={counts}
      />,
    );
    expect(
      screen.getByRole('tablist', { name: 'Tracker tabs' }),
    ).toBeInTheDocument();
    // aria-controls points at the per-tab panel id pattern
    expect(screen.getByRole('tab', { name: /Active/ })).toHaveAttribute(
      'aria-controls',
      'tracker-tab-active',
    );
  });

  it('renders zero counts without crashing', () => {
    const zeros: Record<TrackerTab, number> = {
      active: 0,
      watchlist: 0,
      archive: 0,
    };
    render(
      <TrackerTabs
        current="active"
        onChange={() => undefined}
        counts={zeros}
      />,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    tabs.forEach((t) => expect(t).toHaveTextContent('0'));
  });
});
