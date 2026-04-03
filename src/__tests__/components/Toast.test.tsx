import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  act,
  renderHook,
  fireEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from '../../components/Toast';

// ── Helpers ───────────────────────────────────────────────

function TestConsumer({
  message = 'Test',
  type,
}: {
  message?: string;
  type?: 'success' | 'error' | 'info';
}) {
  const toast = useToast();
  return <button onClick={() => toast.show(message, type)}>trigger</button>;
}

// ── Lifecycle ─────────────────────────────────────────────

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ============================================================
// useToast OUTSIDE PROVIDER
// ============================================================

describe('Toast: useToast outside provider', () => {
  it('throws when called outside ToastProvider', () => {
    // Suppress React error boundary console noise
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(() => useToast())).toThrow(
      'useToast must be used within a ToastProvider',
    );

    spy.mockRestore();
  });
});

// ============================================================
// SHOW TOAST
// ============================================================

describe('Toast: show toast', () => {
  it('renders a toast with the correct message text', async () => {
    const user = userEvent.setup();

    render(
      <ToastProvider>
        <TestConsumer message="Order filled" />
      </ToastProvider>,
    );

    await user.click(screen.getByText('trigger'));

    expect(screen.getByText('Order filled')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

// ============================================================
// TOAST TYPES
// ============================================================

describe('Toast: toast types', () => {
  it('success type applies --color-success style', async () => {
    const user = userEvent.setup();

    render(
      <ToastProvider>
        <TestConsumer message="Saved" type="success" />
      </ToastProvider>,
    );

    await user.click(screen.getByText('trigger'));

    const toast = screen.getByRole('status');
    expect(toast.style.color).toContain('var(--color-success)');
  });

  it('error type applies --color-danger style', async () => {
    const user = userEvent.setup();

    render(
      <ToastProvider>
        <TestConsumer message="Failed" type="error" />
      </ToastProvider>,
    );

    await user.click(screen.getByText('trigger'));

    const toast = screen.getByRole('status');
    expect(toast.style.color).toContain('var(--color-danger)');
  });

  it('info type applies --color-accent style', async () => {
    const user = userEvent.setup();

    render(
      <ToastProvider>
        <TestConsumer message="Note" type="info" />
      </ToastProvider>,
    );

    await user.click(screen.getByText('trigger'));

    const toast = screen.getByRole('status');
    expect(toast.style.color).toContain('var(--color-accent)');
  });
});

// ============================================================
// DISMISS BUTTON
// ============================================================

describe('Toast: dismiss button', () => {
  it('clicking dismiss starts exit animation (animate-toast-out)', () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <TestConsumer message="Bye" />
      </ToastProvider>,
    );

    // Use fireEvent (synchronous) to avoid userEvent + fakeTimers deadlock
    fireEvent.click(screen.getByText('trigger'));

    const toast = screen.getByRole('status');
    expect(toast.className).toContain('animate-toast-in');

    fireEvent.click(screen.getByLabelText('Dismiss notification'));

    // After clicking dismiss, the toast should transition to exiting
    expect(toast.className).toContain('animate-toast-out');
  });
});

// ============================================================
// AUTO-DISMISS
// ============================================================

describe('Toast: auto-dismiss', () => {
  it('gets exiting class after 4000ms', () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <TestConsumer message="Auto" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByText('trigger'));

    const toast = screen.getByRole('status');
    expect(toast.className).toContain('animate-toast-in');

    // Advance past the auto-dismiss timeout
    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(toast.className).toContain('animate-toast-out');
  });

  it('is removed from DOM after 4000ms + 200ms exit animation', () => {
    vi.useFakeTimers();

    render(
      <ToastProvider>
        <TestConsumer message="Gone" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByText('trigger'));

    expect(screen.getByText('Gone')).toBeInTheDocument();

    // Auto-dismiss starts exit
    act(() => {
      vi.advanceTimersByTime(4000);
    });

    // Exit animation completes
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.queryByText('Gone')).not.toBeInTheDocument();
  });
});

// ============================================================
// MAX 3 TOASTS
// ============================================================

describe('Toast: max 3 visible', () => {
  it('showing 4 toasts only keeps 3 visible', () => {
    vi.useFakeTimers();

    function MultiConsumer() {
      const toast = useToast();
      return (
        <>
          <button onClick={() => toast.show('Toast 1')}>t1</button>
          <button onClick={() => toast.show('Toast 2')}>t2</button>
          <button onClick={() => toast.show('Toast 3')}>t3</button>
          <button onClick={() => toast.show('Toast 4')}>t4</button>
        </>
      );
    }

    render(
      <ToastProvider>
        <MultiConsumer />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByText('t1'));
    fireEvent.click(screen.getByText('t2'));
    fireEvent.click(screen.getByText('t3'));
    fireEvent.click(screen.getByText('t4'));

    // After exit animation for evicted toast completes
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(3);

    // Oldest toast should have been evicted
    expect(screen.queryByText('Toast 1')).not.toBeInTheDocument();
    // Newer toasts remain
    expect(screen.getByText('Toast 2')).toBeInTheDocument();
    expect(screen.getByText('Toast 3')).toBeInTheDocument();
    expect(screen.getByText('Toast 4')).toBeInTheDocument();
  });
});

// ============================================================
// DEFAULT TYPE
// ============================================================

describe('Toast: default type', () => {
  it('calling show() without type defaults to info styling', async () => {
    const user = userEvent.setup();

    render(
      <ToastProvider>
        <TestConsumer message="Default" />
      </ToastProvider>,
    );

    await user.click(screen.getByText('trigger'));

    const toast = screen.getByRole('status');
    // Info style uses --color-accent
    expect(toast.style.color).toContain('var(--color-accent)');
  });
});
