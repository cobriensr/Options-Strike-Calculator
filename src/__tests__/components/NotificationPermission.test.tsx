import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotificationPermission from '../../components/NotificationPermission';

// ── Lifecycle ─────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

// ============================================================
// RENDERING CONDITIONS
// ============================================================

describe('NotificationPermission: rendering conditions', () => {
  it('renders when permission is default', () => {
    render(
      <NotificationPermission
        permission="default"
        onRequest={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'Enable desktop notifications for real-time market alerts',
      ),
    ).toBeInTheDocument();
  });

  it('does NOT render when permission is granted', () => {
    const { container } = render(
      <NotificationPermission
        permission="granted"
        onRequest={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('does NOT render when permission is denied', () => {
    const { container } = render(
      <NotificationPermission
        permission="denied"
        onRequest={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('does NOT render when permission is unsupported', () => {
    const { container } = render(
      <NotificationPermission
        permission="unsupported"
        onRequest={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});

// ============================================================
// ENABLE BUTTON
// ============================================================

describe('NotificationPermission: Enable button', () => {
  it('calls onRequest when Enable button is clicked', async () => {
    const user = userEvent.setup();
    const onRequest = vi.fn().mockResolvedValue(undefined);

    render(
      <NotificationPermission
        permission="default"
        onRequest={onRequest}
      />,
    );

    const enableBtn = screen.getByRole('button', { name: 'Enable' });
    await user.click(enableBtn);

    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// DISMISS BEHAVIOR
// ============================================================

describe('NotificationPermission: dismiss behavior', () => {
  it('hides after clicking "Not now"', async () => {
    const user = userEvent.setup();

    const { container } = render(
      <NotificationPermission
        permission="default"
        onRequest={vi.fn()}
      />,
    );

    // Visible before dismiss
    expect(
      screen.getByText(
        'Enable desktop notifications for real-time market alerts',
      ),
    ).toBeInTheDocument();

    const notNowBtn = screen.getByRole('button', { name: 'Not now' });
    await user.click(notNowBtn);

    // Should be hidden after dismiss
    expect(container.innerHTML).toBe('');
  });

  it('sets localStorage key on dismiss', async () => {
    const user = userEvent.setup();

    render(
      <NotificationPermission
        permission="default"
        onRequest={vi.fn()}
      />,
    );

    const notNowBtn = screen.getByRole('button', { name: 'Not now' });
    await user.click(notNowBtn);

    expect(localStorage.getItem('notif-prompt-dismissed')).not.toBeNull();
    const ts = Number(localStorage.getItem('notif-prompt-dismissed'));
    // Timestamp should be a recent value (within last 5 seconds)
    expect(Date.now() - ts).toBeLessThan(5000);
  });
});

// ============================================================
// LOCALSTORAGE PERSISTENCE
// ============================================================

describe('NotificationPermission: localStorage persistence', () => {
  it('does NOT render when localStorage says recently dismissed', () => {
    // Set a recent dismiss timestamp
    localStorage.setItem(
      'notif-prompt-dismissed',
      String(Date.now()),
    );

    const { container } = render(
      <NotificationPermission
        permission="default"
        onRequest={vi.fn()}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('renders again after 24 hours have passed since dismiss', () => {
    vi.useFakeTimers();

    // Set dismiss timestamp to 25 hours ago
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem(
      'notif-prompt-dismissed',
      String(twentyFiveHoursAgo),
    );

    render(
      <NotificationPermission
        permission="default"
        onRequest={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'Enable desktop notifications for real-time market alerts',
      ),
    ).toBeInTheDocument();
  });

  it('does NOT render when dismissed less than 24 hours ago', () => {
    vi.useFakeTimers();

    // Set dismiss timestamp to 23 hours ago
    const twentyThreeHoursAgo = Date.now() - 23 * 60 * 60 * 1000;
    localStorage.setItem(
      'notif-prompt-dismissed',
      String(twentyThreeHoursAgo),
    );

    const { container } = render(
      <NotificationPermission
        permission="default"
        onRequest={vi.fn()}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('handles corrupt localStorage value gracefully', () => {
    localStorage.setItem('notif-prompt-dismissed', 'not-a-number');

    render(
      <NotificationPermission
        permission="default"
        onRequest={vi.fn()}
      />,
    );

    // NaN arithmetic makes isDismissed() return false, so it renders
    expect(
      screen.getByText(
        'Enable desktop notifications for real-time market alerts',
      ),
    ).toBeInTheDocument();
  });
});

// ============================================================
// BUTTONS PRESENT
// ============================================================

describe('NotificationPermission: button presence', () => {
  it('renders both Enable and Not now buttons', () => {
    render(
      <NotificationPermission
        permission="default"
        onRequest={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Enable' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Not now' }),
    ).toBeInTheDocument();
  });
});
