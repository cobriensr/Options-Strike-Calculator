import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { useFocusTrap } from '../useFocusTrap';

function TrappedDialog({ active = true }: { active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref} role="dialog" aria-modal="true">
      <button type="button">first</button>
      <button type="button">middle</button>
      <button type="button">last</button>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('Tab from the last focusable element wraps to the first', async () => {
    const user = userEvent.setup();
    render(<TrappedDialog />);
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });

    last.focus();
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
  });

  it('Shift+Tab from the first focusable element wraps to the last', async () => {
    const user = userEvent.setup();
    render(<TrappedDialog />);
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });

    first.focus();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('does not trap when inactive', async () => {
    const user = userEvent.setup();
    render(
      <>
        <TrappedDialog active={false} />
        <button type="button">outside</button>
      </>,
    );
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    await user.tab();
    // With the trap off, focus moves to the next document element, not back
    // to the dialog's first button.
    expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus();
  });
});
