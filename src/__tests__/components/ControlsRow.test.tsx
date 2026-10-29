import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import ControlsRow from '../../components/AppHeader/ControlsRow';

// jsdom has no layout: give the row the scroll metrics a browser would.
function setMetrics(
  row: HTMLElement,
  m: { scrollWidth: number; clientWidth: number; scrollLeft: number },
) {
  for (const [key, value] of Object.entries(m)) {
    Object.defineProperty(row, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

function renderRow() {
  const utils = render(
    <ControlsRow>
      <button type="button">One</button>
      <button type="button">Two</button>
    </ControlsRow>,
  );
  const row = screen.getByRole('button', { name: 'One' })
    .parentElement as HTMLElement;
  const fade = (edge: 'left' | 'right') =>
    screen.getByTestId(`controls-fade-${edge}`);
  return { ...utils, row, fade };
}

function expectFades(
  fade: (edge: 'left' | 'right') => HTMLElement,
  left: boolean,
  right: boolean,
) {
  expect(fade('left')).toHaveClass(left ? 'opacity-100' : 'opacity-0');
  expect(fade('right')).toHaveClass(right ? 'opacity-100' : 'opacity-0');
}

describe('ControlsRow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders its controls in the row, with decorative edge fades', () => {
    const { row, fade } = renderRow();
    expect(row).toContainElement(screen.getByRole('button', { name: 'Two' }));
    for (const edge of ['left', 'right'] as const) {
      expect(fade(edge)).toHaveAttribute('aria-hidden', 'true');
      expect(fade(edge)).toHaveClass('pointer-events-none');
    }
    // Nothing to scroll in jsdom's zero-size layout.
    expectFades(fade, false, false);
  });

  it('shows a fade on each side the row can still scroll to', () => {
    const { row, fade } = renderRow();

    setMetrics(row, { scrollWidth: 1000, clientWidth: 300, scrollLeft: 0 });
    fireEvent.scroll(row);
    expectFades(fade, false, true);

    setMetrics(row, { scrollWidth: 1000, clientWidth: 300, scrollLeft: 350 });
    fireEvent.scroll(row);
    expectFades(fade, true, true);

    setMetrics(row, { scrollWidth: 1000, clientWidth: 300, scrollLeft: 700 });
    fireEvent.scroll(row);
    expectFades(fade, true, false);
  });

  it('shows no fade when the controls fit', () => {
    const { row, fade } = renderRow();
    setMetrics(row, { scrollWidth: 300, clientWidth: 300, scrollLeft: 0 });
    fireEvent.scroll(row);
    expectFades(fade, false, false);
  });

  it('re-checks when the row or a control resizes, and stops on unmount', () => {
    const callbacks: Array<() => void> = [];
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callbacks.push(cb);
        }
        observe = observe;
        unobserve = vi.fn();
        disconnect = disconnect;
      },
    );
    const { row, fade, unmount } = renderRow();
    // The row and each control are observed.
    const observed = observe.mock.calls.map(([el]) => el as Element);
    expect(observed).toContain(row);
    expect(observed).toContain(screen.getByRole('button', { name: 'Two' }));

    setMetrics(row, { scrollWidth: 800, clientWidth: 300, scrollLeft: 0 });
    act(() => {
      for (const cb of callbacks) cb();
    });
    expectFades(fade, false, true);

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('re-checks when a control is added, and observes the new one', async () => {
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    const { row, fade, rerender } = renderRow();
    setMetrics(row, { scrollWidth: 900, clientWidth: 300, scrollLeft: 0 });
    rerender(
      <ControlsRow>
        <button type="button">One</button>
        <button type="button">Two</button>
        <button type="button">Three</button>
      </ControlsRow>,
    );
    await waitFor(() => expectFades(fade, false, true));
    const observed = observe.mock.calls.map(([el]) => el as Element);
    expect(observed).toContain(screen.getByRole('button', { name: 'Three' }));
  });

  it('stops listening for scrolls once unmounted', () => {
    const { row, unmount } = renderRow();
    const remove = vi.spyOn(row, 'removeEventListener');
    unmount();
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
