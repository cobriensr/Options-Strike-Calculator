/**
 * ScrubControlsCompact tests.
 *
 * Covers the shared contract previously copy-pasted between
 * `DarkPoolLevels` and `GexTarget`'s headers: prev/next button
 * disable state, scrub-to onChange, scrub-live click, label formatter
 * hook, and conditional rendering of the LIVE button + fallback span
 * when `timestamps.length <= 1`.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScrubControlsCompact } from '../../../components/ui/ScrubControlsCompact';

interface Defaults {
  timestamps?: readonly string[];
  currentTimestamp?: string | null;
  canScrubPrev?: boolean;
  canScrubNext?: boolean;
  onScrubPrev?: () => void;
  onScrubNext?: () => void;
  onScrubTo?: (ts: string) => void;
  showLiveButton?: boolean;
  onScrubLive?: () => void;
  formatLabel?: (ts: string) => string;
  displayColor?: string;
  fallbackText?: string;
  prevAriaLabel?: string;
  nextAriaLabel?: string;
}

function renderControls(props: Defaults = {}) {
  // Use `in` to distinguish "not passed" from "passed as null/undefined" so
  // tests can assert the null fallback path.
  const currentTimestamp =
    'currentTimestamp' in props ? (props.currentTimestamp ?? null) : '10:00';
  return render(
    <ScrubControlsCompact
      timestamps={props.timestamps ?? ['09:00', '10:00', '11:00']}
      currentTimestamp={currentTimestamp}
      formatLabel={props.formatLabel ?? ((t) => t)}
      displayColor={props.displayColor ?? '#ff0000'}
      canScrubPrev={props.canScrubPrev ?? true}
      canScrubNext={props.canScrubNext ?? true}
      onScrubPrev={props.onScrubPrev ?? (() => {})}
      onScrubNext={props.onScrubNext ?? (() => {})}
      onScrubTo={props.onScrubTo}
      showLiveButton={props.showLiveButton ?? false}
      onScrubLive={props.onScrubLive}
      fallbackText={props.fallbackText}
      prevAriaLabel={props.prevAriaLabel}
      nextAriaLabel={props.nextAriaLabel}
    />,
  );
}

describe('ScrubControlsCompact', () => {
  it('disables prev/next buttons when scrubbing is bounded', () => {
    renderControls({ canScrubPrev: false, canScrubNext: false });
    expect(
      screen.getByRole('button', { name: 'Previous snapshot' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Next snapshot' }),
    ).toBeDisabled();
  });

  it('enables both buttons when scrubbing is free', () => {
    renderControls({ canScrubPrev: true, canScrubNext: true });
    expect(
      screen.getByRole('button', { name: 'Previous snapshot' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next snapshot' })).toBeEnabled();
  });

  it('forwards prev/next clicks to handlers', async () => {
    const onScrubPrev = vi.fn();
    const onScrubNext = vi.fn();
    renderControls({ onScrubPrev, onScrubNext });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Previous snapshot' }));
    await user.click(screen.getByRole('button', { name: 'Next snapshot' }));
    expect(onScrubPrev).toHaveBeenCalledTimes(1);
    expect(onScrubNext).toHaveBeenCalledTimes(1);
  });

  it('renders <select> with formatted labels when timestamps > 1 + onScrubTo provided', () => {
    renderControls({
      timestamps: ['09:00', '10:00'],
      currentTimestamp: '10:00',
      onScrubTo: vi.fn(),
      formatLabel: (t) => `[${t}]`,
    });
    const select = screen.getByRole('combobox', {
      name: 'Jump to snapshot time',
    });
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '[09:00]' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '[10:00]' })).toBeInTheDocument();
  });

  it('forwards select onChange to onScrubTo', async () => {
    const onScrubTo = vi.fn();
    renderControls({
      timestamps: ['09:00', '10:00', '11:00'],
      currentTimestamp: '10:00',
      onScrubTo,
    });
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Jump to snapshot time' }),
      '11:00',
    );
    expect(onScrubTo).toHaveBeenCalledWith('11:00');
  });

  it('falls back to <span> when only one timestamp', () => {
    renderControls({
      timestamps: ['10:00'],
      currentTimestamp: '10:00',
      onScrubTo: vi.fn(),
    });
    expect(
      screen.queryByRole('combobox', { name: 'Jump to snapshot time' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('10:00')).toBeInTheDocument();
  });

  it('falls back to <span> when onScrubTo is not provided', () => {
    renderControls({
      timestamps: ['09:00', '10:00'],
      currentTimestamp: '10:00',
      onScrubTo: undefined,
    });
    expect(
      screen.queryByRole('combobox', { name: 'Jump to snapshot time' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('10:00')).toBeInTheDocument();
  });

  it('renders fallback span text when currentTimestamp is null', () => {
    renderControls({
      timestamps: [],
      currentTimestamp: null,
      fallbackText: '11:30',
    });
    expect(screen.getByText('11:30')).toBeInTheDocument();
  });

  it('omits the LIVE button when showLiveButton=false', () => {
    renderControls({ showLiveButton: false, onScrubLive: vi.fn() });
    expect(
      screen.queryByRole('button', { name: 'Resume live' }),
    ).not.toBeInTheDocument();
  });

  it('omits the LIVE button when onScrubLive is missing even if showLiveButton=true', () => {
    renderControls({ showLiveButton: true, onScrubLive: undefined });
    expect(
      screen.queryByRole('button', { name: 'Resume live' }),
    ).not.toBeInTheDocument();
  });

  it('renders + forwards LIVE button click when both showLiveButton and onScrubLive are set', async () => {
    const onScrubLive = vi.fn();
    renderControls({ showLiveButton: true, onScrubLive });
    const liveBtn = screen.getByRole('button', { name: 'Resume live' });
    expect(liveBtn).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(liveBtn);
    expect(onScrubLive).toHaveBeenCalledTimes(1);
  });

  it('respects custom prev/next aria labels', () => {
    renderControls({
      prevAriaLabel: 'Earlier snapshot',
      nextAriaLabel: 'Later snapshot',
    });
    expect(
      screen.getByRole('button', { name: 'Earlier snapshot' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Later snapshot' }),
    ).toBeInTheDocument();
  });
});
