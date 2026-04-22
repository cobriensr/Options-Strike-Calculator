/**
 * AlertConfigPanel tests — presentation + config wiring.
 *
 * Drives the per-channel + per-type + permission button branches.
 * `setConfig` is a vitest mock so we can assert exactly what config
 * shape the panel emits on each control flip.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Mock the push hook so we don't need to fake out serviceWorker + fetch
// in every test — the push-section branches are driven by its return
// value shape alone.
vi.mock('../../../hooks/usePushSubscription', () => ({
  usePushSubscription: vi.fn(),
}));

import { AlertConfigPanel } from '../../../components/FuturesGammaPlaybook/AlertConfig';
import type { AlertConfig } from '../../../components/FuturesGammaPlaybook/useAlertDispatcher';
import { usePushSubscription } from '../../../hooks/usePushSubscription';
import type { UsePushSubscriptionReturn } from '../../../hooks/usePushSubscription';

function makePush(
  overrides: Partial<UsePushSubscriptionReturn> = {},
): UsePushSubscriptionReturn {
  return {
    permission: 'default',
    isSubscribed: false,
    isSubscribing: false,
    error: null,
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    requestPermission: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(usePushSubscription).mockReturnValue(makePush());
});

function makeConfig(overrides: Partial<AlertConfig> = {}): AlertConfig {
  return {
    enabled: true,
    toast: true,
    notification: false,
    audio: false,
    cooldownSeconds: {},
    types: {
      REGIME_FLIP: true,
      LEVEL_APPROACH: true,
      LEVEL_BREACH: true,
      TRIGGER_FIRE: true,
      PHASE_TRANSITION: true,
    },
    ...overrides,
  };
}

describe('AlertConfigPanel', () => {
  it('renders channel toggles with their current state', () => {
    const setConfig = vi.fn();
    const requestPermission = vi.fn();
    render(
      <AlertConfigPanel
        config={makeConfig({ toast: true, notification: false, audio: false })}
        setConfig={setConfig}
        permission="default"
        requestPermission={requestPermission}
      />,
    );
    const toast = screen.getByLabelText('In-app toast') as HTMLInputElement;
    const notif = screen.getByLabelText(
      'Browser notification',
    ) as HTMLInputElement;
    const audio = screen.getByLabelText('Audio cue') as HTMLInputElement;
    expect(toast.checked).toBe(true);
    expect(notif.checked).toBe(false);
    expect(audio.checked).toBe(false);
  });

  it('flipping a per-channel toggle emits the new config', () => {
    const setConfig = vi.fn();
    render(
      <AlertConfigPanel
        config={makeConfig({ audio: false })}
        setConfig={setConfig}
        permission="granted"
        requestPermission={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Audio cue'));
    expect(setConfig).toHaveBeenCalledTimes(1);
    const next = setConfig.mock.calls[0]?.[0] as AlertConfig;
    expect(next.audio).toBe(true);
  });

  it('flipping the master toggle emits enabled=false', () => {
    const setConfig = vi.fn();
    render(
      <AlertConfigPanel
        config={makeConfig({ enabled: true })}
        setConfig={setConfig}
        permission="granted"
        requestPermission={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Enable alerts'));
    expect(setConfig).toHaveBeenCalledTimes(1);
    const next = setConfig.mock.calls[0]?.[0] as AlertConfig;
    expect(next.enabled).toBe(false);
  });

  it('disables per-channel controls when master is off', () => {
    render(
      <AlertConfigPanel
        config={makeConfig({ enabled: false })}
        setConfig={vi.fn()}
        permission="granted"
        requestPermission={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('In-app toast')).toBeDisabled();
    expect(screen.getByLabelText('Browser notification')).toBeDisabled();
    expect(screen.getByLabelText('Audio cue')).toBeDisabled();
  });

  it('shows the permission button when permission is default', () => {
    const requestPermission = vi.fn().mockResolvedValue(undefined);
    render(
      <AlertConfigPanel
        config={makeConfig()}
        setConfig={vi.fn()}
        permission="default"
        requestPermission={requestPermission}
      />,
    );
    const btn = screen.getByRole('button', {
      name: /browser notification permission/i,
    });
    fireEvent.click(btn);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('shows a retry button with blocked-hint when permission is denied', () => {
    render(
      <AlertConfigPanel
        config={makeConfig()}
        setConfig={vi.fn()}
        permission="denied"
        requestPermission={vi.fn()}
      />,
    );
    expect(screen.getByText(/blocked/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /permission/i }),
    ).toBeInTheDocument();
  });

  it('hides the permission button and disables notification when unsupported', () => {
    render(
      <AlertConfigPanel
        config={makeConfig()}
        setConfig={vi.fn()}
        permission="unsupported"
        requestPermission={vi.fn()}
      />,
    );
    expect(screen.getByText(/not supported/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /permission/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Browser notification')).toBeDisabled();
  });

  it('hides the permission button when permission is already granted', () => {
    render(
      <AlertConfigPanel
        config={makeConfig()}
        setConfig={vi.fn()}
        permission="granted"
        requestPermission={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /permission/i }),
    ).not.toBeInTheDocument();
  });

  it('flipping a per-type toggle updates the types map only', () => {
    const setConfig = vi.fn();
    render(
      <AlertConfigPanel
        config={makeConfig()}
        setConfig={setConfig}
        permission="granted"
        requestPermission={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText(/Enable Regime flip alerts/i));
    const next = setConfig.mock.calls[0]?.[0] as AlertConfig;
    expect(next.types.REGIME_FLIP).toBe(false);
    expect(next.types.LEVEL_APPROACH).toBe(true);
  });

  it('editing a cooldown emits a Number-parsed value for that type', () => {
    const setConfig = vi.fn();
    render(
      <AlertConfigPanel
        config={makeConfig()}
        setConfig={setConfig}
        permission="granted"
        requestPermission={vi.fn()}
      />,
    );
    const cdInput = screen.getByLabelText(
      /Regime flip cooldown in seconds/i,
    ) as HTMLInputElement;
    fireEvent.change(cdInput, { target: { value: '30' } });
    const next = setConfig.mock.calls[0]?.[0] as AlertConfig;
    expect(next.cooldownSeconds.REGIME_FLIP).toBe(30);
  });

  it('renders all five type rows', () => {
    render(
      <AlertConfigPanel
        config={makeConfig()}
        setConfig={vi.fn()}
        permission="granted"
        requestPermission={vi.fn()}
      />,
    );
    // Scope to the config panel group to avoid matching external nodes.
    const panel = screen.getByRole('group', { name: /alert configuration/i });
    expect(within(panel).getByText('Regime flip')).toBeInTheDocument();
    expect(within(panel).getByText('Level approach')).toBeInTheDocument();
    expect(within(panel).getByText('Level breach')).toBeInTheDocument();
    expect(within(panel).getByText('Trigger fired')).toBeInTheDocument();
    expect(within(panel).getByText('Phase transition')).toBeInTheDocument();
  });

  // ── Push-subscription subsection ──────────────────────────────

  describe('push subscription section', () => {
    it('renders the subscribe button and "Not subscribed" when permission is default', () => {
      vi.mocked(usePushSubscription).mockReturnValue(
        makePush({ permission: 'default', isSubscribed: false }),
      );
      render(
        <AlertConfigPanel
          config={makeConfig()}
          setConfig={vi.fn()}
          permission="default"
          requestPermission={vi.fn()}
        />,
      );
      const pushGroup = screen.getByRole('group', {
        name: /push notifications/i,
      });
      expect(
        within(pushGroup).getByText(/not subscribed/i),
      ).toBeInTheDocument();
      expect(
        within(pushGroup).getByRole('button', {
          name: /subscribe this device/i,
        }),
      ).toBeInTheDocument();
    });

    it('clicking subscribe calls the hook', () => {
      const subscribe = vi.fn(async () => undefined);
      vi.mocked(usePushSubscription).mockReturnValue(
        makePush({ permission: 'granted', subscribe }),
      );
      render(
        <AlertConfigPanel
          config={makeConfig()}
          setConfig={vi.fn()}
          permission="granted"
          requestPermission={vi.fn()}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: /subscribe this device/i }),
      );
      expect(subscribe).toHaveBeenCalledTimes(1);
    });

    it('renders the unsubscribe button when already subscribed', () => {
      const unsubscribe = vi.fn(async () => undefined);
      vi.mocked(usePushSubscription).mockReturnValue(
        makePush({
          permission: 'granted',
          isSubscribed: true,
          unsubscribe,
        }),
      );
      render(
        <AlertConfigPanel
          config={makeConfig()}
          setConfig={vi.fn()}
          permission="granted"
          requestPermission={vi.fn()}
        />,
      );
      const pushGroup = screen.getByRole('group', {
        name: /push notifications/i,
      });
      expect(
        within(pushGroup).getByText(/subscribed on this device/i),
      ).toBeInTheDocument();
      fireEvent.click(
        within(pushGroup).getByRole('button', {
          name: /unsubscribe this device/i,
        }),
      );
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('hides subscribe when permission is denied and shows the state label', () => {
      vi.mocked(usePushSubscription).mockReturnValue(
        makePush({ permission: 'denied' }),
      );
      render(
        <AlertConfigPanel
          config={makeConfig()}
          setConfig={vi.fn()}
          permission="granted"
          requestPermission={vi.fn()}
        />,
      );
      const pushGroup = screen.getByRole('group', {
        name: /push notifications/i,
      });
      expect(
        within(pushGroup).getByText(/permission denied/i),
      ).toBeInTheDocument();
      expect(
        within(pushGroup).queryByRole('button', {
          name: /subscribe this device/i,
        }),
      ).not.toBeInTheDocument();
    });

    it('renders the unsupported state without action buttons', () => {
      vi.mocked(usePushSubscription).mockReturnValue(
        makePush({ permission: 'unsupported' }),
      );
      render(
        <AlertConfigPanel
          config={makeConfig()}
          setConfig={vi.fn()}
          permission="granted"
          requestPermission={vi.fn()}
        />,
      );
      const pushGroup = screen.getByRole('group', {
        name: /push notifications/i,
      });
      expect(
        within(pushGroup).getByText(/not supported on this browser/i),
      ).toBeInTheDocument();
      expect(
        within(pushGroup).queryByRole('button', {
          name: /subscribe this device/i,
        }),
      ).not.toBeInTheDocument();
      expect(
        within(pushGroup).queryByRole('button', {
          name: /unsubscribe this device/i,
        }),
      ).not.toBeInTheDocument();
    });

    it('surfaces hook-level errors inside the push section', () => {
      vi.mocked(usePushSubscription).mockReturnValue(
        makePush({ error: 'Server refused subscription (500)' }),
      );
      render(
        <AlertConfigPanel
          config={makeConfig()}
          setConfig={vi.fn()}
          permission="granted"
          requestPermission={vi.fn()}
        />,
      );
      const pushGroup = screen.getByRole('group', {
        name: /push notifications/i,
      });
      expect(within(pushGroup).getByRole('alert')).toHaveTextContent(
        /server refused/i,
      );
    });

    it('disables the subscribe button while subscribing', () => {
      vi.mocked(usePushSubscription).mockReturnValue(
        makePush({ permission: 'granted', isSubscribing: true }),
      );
      render(
        <AlertConfigPanel
          config={makeConfig()}
          setConfig={vi.fn()}
          permission="granted"
          requestPermission={vi.fn()}
        />,
      );
      expect(
        screen.getByRole('button', { name: /subscribe this device/i }),
      ).toBeDisabled();
    });
  });
});
