import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ErrorBoundary from '../components/ErrorBoundary';

// Suppress React's error boundary console noise during tests
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});

afterAll(() => {
  console.error = originalConsoleError;
});

function ThrowingChild({ message }: { message: string }): React.ReactNode {
  throw new Error(message);
}

function GoodChild() {
  return <div>All good</div>;
}

describe('ErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('renders error UI when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="kaboom" />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(
      screen.getByText(
        'An unexpected error occurred. Try refreshing the page.',
      ),
    ).toBeInTheDocument();
  });

  it('displays the error message', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="test error message" />
      </ErrorBoundary>,
    );

    expect(screen.getByText('test error message')).toBeInTheDocument();
  });

  it('renders a Reload Page button', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="fail" />
      </ErrorBoundary>,
    );

    expect(
      screen.getByRole('button', { name: 'Reload Page' }),
    ).toBeInTheDocument();
  });

  it('calls globalThis.location.reload when Reload Page is clicked', async () => {
    const user = userEvent.setup();
    const reloadMock = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      value: { ...globalThis.location, reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ThrowingChild message="fail" />
      </ErrorBoundary>,
    );

    await user.click(screen.getByRole('button', { name: 'Reload Page' }));
    expect(reloadMock).toHaveBeenCalledOnce();
  });

  it('logs error via componentDidCatch', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="logged error" />
      </ErrorBoundary>,
    );

    expect(console.error).toHaveBeenCalledWith(
      'ErrorBoundary caught:',
      expect.any(Error),
      expect.any(String),
    );
  });
});
