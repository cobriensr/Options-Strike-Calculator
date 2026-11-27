/**
 * SlotPicker unit tests. The live toggle's dot means "streaming", so it shows
 * only on the live route while the market is open; after the close the panel
 * header carries the capture time and the asOf time beside the toggle goes
 * (spec: gexbot-after-close-design, Task 17).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlotPicker } from '../components/Periscope/SlotPicker';
import { theme } from '../themes';

// Friday 2026-11-20 (CST, UTC-6): 20:50Z is 14:50 CT.
const SLOTS = [
  '2026-11-20T20:40:00Z',
  '2026-11-20T20:50:00Z',
  '2026-11-20T21:00:00Z',
];
const AS_OF = '2026-11-20T21:00:50Z';

function makeProps(overrides: Partial<Parameters<typeof SlotPicker>[0]> = {}) {
  return {
    displayedDate: '2026-11-20',
    displayedTime: '15:00',
    availableSlots: SLOTS,
    currentSlotIso: SLOTS[2],
    currentIdx: 2,
    canPrev: true,
    canNext: false,
    isLive: true,
    marketOpen: true,
    asOf: AS_OF,
    loading: false,
    onSelectSlot: vi.fn(),
    onRefresh: vi.fn(),
    stepTo: vi.fn(),
    ...overrides,
  };
}

function liveToggle() {
  return screen.getByRole('button', { name: 'Return to live' });
}

describe('SlotPicker: live toggle', () => {
  it('open on the live route: shows the streaming dot and the asOf time', () => {
    render(<SlotPicker {...makeProps()} />);
    expect(liveToggle()).toHaveTextContent('● live');
    expect(liveToggle()).toBeDisabled();
    expect(screen.getByText(/^3:00\sPM CT$/)).toBeInTheDocument();
  });

  it('closed on the live route: no dot, no asOf time', () => {
    render(<SlotPicker {...makeProps({ marketOpen: false })} />);
    expect(liveToggle()).toHaveTextContent(/^live$/);
    // Still the live route: nothing to return to.
    expect(liveToggle()).toBeDisabled();
    expect(screen.queryByText(/CT$/)).toBeNull();
  });

  // The green accent says "streaming", like the dot. A live toggle on a closed
  // market streams nothing, so it reads as a plain (disabled) button.
  it('open on the live route: carries the green streaming accent', () => {
    render(<SlotPicker {...makeProps()} />);
    expect(liveToggle().style.color).toBe(theme.green);
    expect(liveToggle().style.backgroundColor).toBe(theme.accentBg);
  });

  it('closed on the live route: looks like a plain button, not a streaming one', () => {
    render(<SlotPicker {...makeProps({ marketOpen: false })} />);
    expect(liveToggle().style.color).toBe(theme.text);
    expect(liveToggle().style.backgroundColor).toBe(theme.chipBg);
  });

  it('closed on the live route: matches the toggle of a picked slot', () => {
    const closed = render(<SlotPicker {...makeProps({ marketOpen: false })} />);
    const closedStyle = liveToggle().getAttribute('style');
    closed.unmount();
    render(<SlotPicker {...makeProps({ isLive: false, marketOpen: false })} />);
    expect(liveToggle().getAttribute('style')).toBe(closedStyle);
  });

  it('keeps the same accessible name with or without the dot', () => {
    const { rerender } = render(<SlotPicker {...makeProps()} />);
    expect(liveToggle()).toBeInTheDocument();
    rerender(<SlotPicker {...makeProps({ marketOpen: false })} />);
    expect(liveToggle()).toBeInTheDocument();
  });

  it.each([true, false])(
    'on a picked slot (market open: %s): reads live, enabled, no asOf, and drops back to live on click',
    (marketOpen) => {
      const onSelectSlot = vi.fn();
      render(
        <SlotPicker
          {...makeProps({ isLive: false, marketOpen, onSelectSlot })}
        />,
      );
      expect(liveToggle()).toHaveTextContent(/^live$/);
      expect(liveToggle()).toBeEnabled();
      expect(screen.queryByText(/CT$/)).toBeNull();
      fireEvent.click(liveToggle());
      expect(onSelectSlot).toHaveBeenCalledWith(null);
    },
  );

  it('open with no asOf yet: shows the dot and no time', () => {
    render(<SlotPicker {...makeProps({ asOf: null })} />);
    expect(liveToggle()).toHaveTextContent('● live');
    expect(screen.queryByText(/CT$/)).toBeNull();
  });
});

describe('SlotPicker: slot controls', () => {
  it('lists the slots as CT times and steps to the one picked', () => {
    const stepTo = vi.fn();
    render(<SlotPicker {...makeProps({ stepTo })} />);
    const select = screen.getByRole('combobox', {
      name: 'Periscope slot time',
    });
    expect(
      Array.from(select.querySelectorAll('option')).map((o) => o.text),
    ).toEqual(['14:40', '14:50', '15:00']);
    fireEvent.change(select, { target: { value: SLOTS[1] } });
    expect(stepTo).toHaveBeenCalledWith(SLOTS[1]);
  });

  it('steps back from the current slot, and disables next at the last one', () => {
    const stepTo = vi.fn();
    render(<SlotPicker {...makeProps({ stepTo })} />);
    expect(screen.getByRole('button', { name: 'Next slot' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous slot' }));
    expect(stepTo).toHaveBeenCalledWith(SLOTS[1]);
  });

  it('jumps to the end of the day when the date changes', () => {
    const onSelectSlot = vi.fn();
    render(<SlotPicker {...makeProps({ onSelectSlot })} />);
    fireEvent.change(screen.getByLabelText('Periscope slot date'), {
      target: { value: '2026-11-19' },
    });
    expect(onSelectSlot).toHaveBeenCalledWith({
      date: '2026-11-19',
      time: '23:59',
    });
  });

  it('disables the time dropdown when the day has no slots', () => {
    render(
      <SlotPicker
        {...makeProps({
          availableSlots: [],
          currentSlotIso: undefined,
          currentIdx: -1,
          canPrev: false,
        })}
      />,
    );
    expect(
      screen.getByRole('combobox', { name: 'Periscope slot time' }),
    ).toBeDisabled();
  });

  it('refreshes on click and shows an ellipsis while loading', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<SlotPicker {...makeProps({ onRefresh })} />);
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerender(<SlotPicker {...makeProps({ onRefresh, loading: true })} />);
    expect(screen.getByRole('button', { name: '…' })).toBeDisabled();
  });
});
