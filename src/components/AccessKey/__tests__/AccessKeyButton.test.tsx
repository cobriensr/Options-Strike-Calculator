import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AccessKeyButton from '../AccessKeyButton';
import type { AccessMode } from '../../../utils/auth';

// Mock the AccessKeyModal so these tests focus on the button's behavior
// (open/close orchestration, label, prop wiring) rather than re-asserting
// modal internals already covered by AccessKeyModal.test.tsx.
vi.mock('../AccessKeyModal', () => ({
  default: (props: {
    mode: AccessMode;
    onClose: () => void;
    onLoginSuccess: () => void;
    onLogout: () => Promise<void>;
  }) => (
    <div data-testid="mock-modal" data-mode={props.mode}>
      <button type="button" onClick={props.onClose}>
        mock-close
      </button>
      <button type="button" onClick={props.onLoginSuccess}>
        mock-login-success
      </button>
      <button
        type="button"
        onClick={() => {
          props.onLogout().catch(() => {});
        }}
      >
        mock-logout
      </button>
    </div>
  ),
}));

const refreshMock = vi.fn();
const logoutMock = vi.fn().mockResolvedValue(undefined);
let currentMode: AccessMode = 'public';

vi.mock('../../../hooks/useAccessSession', () => ({
  useAccessSession: () => ({
    mode: currentMode,
    refresh: refreshMock,
    logout: logoutMock,
  }),
}));

beforeEach(() => {
  refreshMock.mockReset();
  logoutMock.mockReset().mockResolvedValue(undefined);
  currentMode = 'public';
});

describe('AccessKeyButton — public mode', () => {
  it('renders the trigger button with the public aria-label and "Access" copy', () => {
    render(<AccessKeyButton />);
    const btn = screen.getByRole('button', { name: /enter access key/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('title', 'Enter access key');
    expect(btn).toHaveTextContent(/access/i);
  });

  it('does not render the modal until the trigger is clicked', () => {
    render(<AccessKeyButton />);
    expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /enter access key/i }));
    expect(screen.getByTestId('mock-modal')).toBeInTheDocument();
    expect(screen.getByTestId('mock-modal')).toHaveAttribute(
      'data-mode',
      'public',
    );
  });

  it('closes the modal when the modal calls onClose', () => {
    render(<AccessKeyButton />);
    fireEvent.click(screen.getByRole('button', { name: /enter access key/i }));
    fireEvent.click(screen.getByRole('button', { name: 'mock-close' }));
    expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
  });

  it('invokes refresh and closes the modal on successful login', () => {
    render(<AccessKeyButton />);
    fireEvent.click(screen.getByRole('button', { name: /enter access key/i }));
    fireEvent.click(screen.getByRole('button', { name: 'mock-login-success' }));
    expect(refreshMock).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('mock-modal')).not.toBeInTheDocument();
  });
});

describe('AccessKeyButton — guest mode', () => {
  it('uses the guest aria-label and "Guest" copy', () => {
    currentMode = 'guest';
    render(<AccessKeyButton />);
    const btn = screen.getByRole('button', {
      name: /guest mode active — open access menu/i,
    });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/guest/i);
  });

  it('passes the logout handler through to the modal', () => {
    currentMode = 'guest';
    render(<AccessKeyButton />);
    fireEvent.click(
      screen.getByRole('button', {
        name: /guest mode active — open access menu/i,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'mock-logout' }));
    expect(logoutMock).toHaveBeenCalledOnce();
  });
});

describe('AccessKeyButton — owner mode', () => {
  it('uses the owner aria-label and "Owner" copy', () => {
    currentMode = 'owner';
    render(<AccessKeyButton />);
    const btn = screen.getByRole('button', {
      name: /owner mode active — open access menu/i,
    });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/owner/i);
  });
});

describe('AccessKeyButton — compact variant', () => {
  it('renders the same accessible name regardless of compact prop', () => {
    render(<AccessKeyButton compact />);
    expect(
      screen.getByRole('button', { name: /enter access key/i }),
    ).toBeInTheDocument();
  });
});
