/**
 * Tooltip primitive tests.
 *
 * Covers the public contract of `src/components/ui/Tooltip.tsx`:
 *  - mouse enter/leave show/hide
 *  - focus/blur show/hide
 *  - Escape key dismisses
 *  - `aria-describedby` is wired to the tooltip id while shown
 *  - rich content renders
 *  - `side` prop affects positioning classes
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tooltip } from '../../../components/ui/Tooltip';

describe('Tooltip', () => {
  it('hides the popover by default', () => {
    render(
      <Tooltip content="Hint">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getByText('Trigger')).not.toHaveAttribute(
      'aria-describedby',
    );
  });

  it('shows the popover on mouseenter and hides on mouseleave', () => {
    render(
      <Tooltip content="Hover hint">
        <span data-testid="trigger">Trigger</span>
      </Tooltip>,
    );
    // The wrapper <span> owns the mouse handlers — find it via the trigger.
    const wrapper = screen.getByTestId('trigger').parentElement as HTMLElement;
    expect(wrapper).not.toBeNull();

    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Hover hint');

    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows on focus and hides on blur', () => {
    render(
      <Tooltip content="Focus hint">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Trigger' });

    fireEvent.focus(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Focus hint');

    fireEvent.blur(button);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses with Escape', () => {
    render(
      <Tooltip content="Escape hint">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const wrapper = screen.getByRole('button', { name: 'Trigger' })
      .parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('wires aria-describedby to the tooltip id while shown', () => {
    render(
      <Tooltip content="Described">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Trigger' });
    const wrapper = button.parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    const popover = screen.getByRole('tooltip');
    const describedBy = wrapper.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(popover.id).toBe(describedBy);
  });

  it('renders rich ReactNode content', () => {
    render(
      <Tooltip
        content={
          <span>
            <strong>bold</strong> and plain
          </span>
        }
      >
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const wrapper = screen.getByRole('button').parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    const popover = screen.getByRole('tooltip');
    expect(popover).toHaveTextContent('bold and plain');
    expect(popover.querySelector('strong')).not.toBeNull();
  });

  it('applies a distinct positioning class per side prop', () => {
    const { rerender } = render(
      <Tooltip content="Side" side="top">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    let wrapper = screen.getByRole('button').parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip').className).toMatch(/bottom-full/);

    rerender(
      <Tooltip content="Side" side="bottom">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    wrapper = screen.getByRole('button').parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip').className).toMatch(/top-full/);

    rerender(
      <Tooltip content="Side" side="left">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    wrapper = screen.getByRole('button').parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip').className).toMatch(/right-full/);

    rerender(
      <Tooltip content="Side" side="right">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    wrapper = screen.getByRole('button').parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole('tooltip').className).toMatch(/left-full/);
  });

  it('respects the maxWidth prop', () => {
    render(
      <Tooltip content="Wide" maxWidth={400}>
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const wrapper = screen.getByRole('button').parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    const popover = screen.getByRole('tooltip');
    expect(popover.style.maxWidth).toBe('400px');
  });
});
