import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OtmFlowControls } from '../../../components/OtmFlowAlerts/OtmFlowControls';
import type { OtmFlowSettings } from '../../../types/otm-flow';

// ── Fixture ───────────────────────────────────────────────

function baseSettings(
  overrides: Partial<OtmFlowSettings> = {},
): OtmFlowSettings {
  return {
    windowMinutes: 30,
    minAskRatio: 0.6,
    minBidRatio: 0.6,
    minDistancePct: 0.005,
    minPremium: 50_000,
    sides: 'both',
    type: 'both',
    mode: 'live',
    historicalDate: '',
    historicalTime: '',
    audioOn: true,
    notificationsOn: false,
    ...overrides,
  };
}

type UpdateFn = (patch: Partial<OtmFlowSettings>) => void;
type VoidFn = () => void;

function renderControls(
  settings: OtmFlowSettings = baseSettings(),
  opts: {
    updateSettings?: UpdateFn;
    resetSettings?: VoidFn;
    notificationPermission?: NotificationPermission | 'unsupported';
    requestNotificationPermission?: VoidFn;
  } = {},
) {
  const updateSettings: UpdateFn = opts.updateSettings ?? vi.fn();
  const resetSettings: VoidFn = opts.resetSettings ?? vi.fn();
  const requestNotificationPermission: VoidFn =
    opts.requestNotificationPermission ?? vi.fn();
  const utils = render(
    <OtmFlowControls
      settings={settings}
      updateSettings={updateSettings}
      resetSettings={resetSettings}
      notificationPermission={opts.notificationPermission ?? 'default'}
      requestNotificationPermission={requestNotificationPermission}
    />,
  );
  return {
    ...utils,
    updateSettings: updateSettings as ReturnType<typeof vi.fn>,
    resetSettings: resetSettings as ReturnType<typeof vi.fn>,
    requestNotificationPermission: requestNotificationPermission as ReturnType<
      typeof vi.fn
    >,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

// ══════════════════════════════════════════════════════════
// LAYOUT — controls render in both modes
// ══════════════════════════════════════════════════════════

describe('OtmFlowControls — layout', () => {
  it('renders Live/Historical/Audio/Notify/reset controls', () => {
    renderControls();
    expect(screen.getByRole('button', { name: /^live$/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^historical$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /audio on/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /notify off/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
  });

  it('does NOT render date/time inputs in live mode', () => {
    renderControls(baseSettings({ mode: 'live' }));
    expect(screen.queryByLabelText(/historical date/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/historical time/i)).not.toBeInTheDocument();
  });

  it('renders date + time inputs when mode=historical', () => {
    renderControls(
      baseSettings({
        mode: 'historical',
        historicalDate: '2026-04-21',
        historicalTime: '10:30',
      }),
    );
    expect(screen.getByLabelText(/historical date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/historical time/i)).toBeInTheDocument();
  });

  it('renders all 4 sliders with range type and correct bounds', () => {
    renderControls();

    const askSlider = screen.getByRole('slider', {
      name: /minimum ask-side ratio/i,
    });
    expect(askSlider).toHaveAttribute('min', '0.5');
    expect(askSlider).toHaveAttribute('max', '0.95');

    const bidSlider = screen.getByRole('slider', {
      name: /minimum bid-side ratio/i,
    });
    expect(bidSlider).toHaveAttribute('min', '0.5');
    expect(bidSlider).toHaveAttribute('max', '0.95');

    const distSlider = screen.getByRole('slider', {
      name: /minimum absolute distance from spot/i,
    });
    expect(distSlider).toHaveAttribute('min', '0.001');
    expect(distSlider).toHaveAttribute('max', '0.02');

    const premSlider = screen.getByRole('slider', {
      name: /minimum total premium/i,
    });
    expect(premSlider).toHaveAttribute('min', '10000');
    expect(premSlider).toHaveAttribute('max', '500000');
  });

  it('exposes aria-valuetext on every slider with a formatted string', () => {
    renderControls();
    expect(
      screen.getByRole('slider', { name: /minimum ask-side ratio/i }),
    ).toHaveAttribute('aria-valuetext', '60%');
    expect(
      screen.getByRole('slider', {
        name: /minimum absolute distance from spot/i,
      }),
    ).toHaveAttribute('aria-valuetext', '0.50%');
    expect(
      screen.getByRole('slider', { name: /minimum total premium/i }),
    ).toHaveAttribute('aria-valuetext', '$50K');
  });
});

// ══════════════════════════════════════════════════════════
// IMMEDIATE-COMMIT TOGGLES
// ══════════════════════════════════════════════════════════

describe('OtmFlowControls — immediate-commit toggles', () => {
  it('commits mode=historical immediately on Historical click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { updateSettings } = renderControls();

    await user.click(screen.getByRole('button', { name: /^historical$/i }));
    expect(updateSettings).toHaveBeenCalledWith({ mode: 'historical' });
  });

  it('commits sides=ask on Ask-heavy click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { updateSettings } = renderControls();

    await user.click(screen.getByRole('button', { name: /^ask-heavy$/i }));
    expect(updateSettings).toHaveBeenCalledWith({ sides: 'ask' });
  });

  it('commits type=put on Puts click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { updateSettings } = renderControls();

    await user.click(screen.getByRole('button', { name: /^puts$/i }));
    expect(updateSettings).toHaveBeenCalledWith({ type: 'put' });
  });

  it('commits sides=bid on Bid-heavy click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { updateSettings } = renderControls();

    await user.click(screen.getByRole('button', { name: /^bid-heavy$/i }));
    expect(updateSettings).toHaveBeenCalledWith({ sides: 'bid' });
  });

  it('commits type=call on Calls click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { updateSettings } = renderControls(baseSettings({ type: 'put' }));

    await user.click(screen.getByRole('button', { name: /^calls$/i }));
    expect(updateSettings).toHaveBeenCalledWith({ type: 'call' });
  });

  it('commits type=both on Both click (type row)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { updateSettings } = renderControls(baseSettings({ type: 'put' }));

    // There are two "Both" chips — one for sides, one for type. Grab all,
    // click the type-row one (second in document order).
    const bothChips = screen.getAllByRole('button', { name: /^both$/i });
    await user.click(bothChips[1]!);
    expect(updateSettings).toHaveBeenCalledWith({ type: 'both' });
  });

  it('commits audioOn flip on Audio toggle', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { updateSettings } = renderControls();

    await user.click(screen.getByRole('button', { name: /audio on/i }));
    expect(updateSettings).toHaveBeenCalledWith({ audioOn: false });
  });

  it('calls resetSettings on reset click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { resetSettings } = renderControls();

    await user.click(screen.getByRole('button', { name: /reset/i }));
    expect(resetSettings).toHaveBeenCalled();
  });

  it('commits historicalDate on date input change', () => {
    const { updateSettings } = renderControls(
      baseSettings({
        mode: 'historical',
        historicalDate: '2026-04-21',
        historicalTime: '10:30',
      }),
    );

    const input = screen.getByLabelText(/historical date/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-04-15' } });
    expect(updateSettings).toHaveBeenCalledWith({
      historicalDate: '2026-04-15',
    });
  });

  it('commits historicalTime on time input change', () => {
    const { updateSettings } = renderControls(
      baseSettings({
        mode: 'historical',
        historicalDate: '2026-04-21',
        historicalTime: '10:30',
      }),
    );

    const input = screen.getByLabelText(/historical time/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '14:30' } });
    expect(updateSettings).toHaveBeenCalledWith({ historicalTime: '14:30' });
  });
});

// ══════════════════════════════════════════════════════════
// NOTIFICATION-PERMISSION STATES
// ══════════════════════════════════════════════════════════

describe('OtmFlowControls — notification permission states', () => {
  it('enables the notify button when permission is default', () => {
    renderControls(baseSettings(), { notificationPermission: 'default' });
    const btn = screen.getByRole('button', { name: /notify off/i });
    expect(btn).not.toBeDisabled();
  });

  it('disables the notify button and shows "Notify blocked" when permission=denied', () => {
    renderControls(baseSettings(), { notificationPermission: 'denied' });
    const btn = screen.getByRole('button', { name: /notify blocked/i });
    expect(btn).toBeDisabled();
  });

  it('disables the notify button and shows "Notify n/a" when permission=unsupported', () => {
    renderControls(baseSettings(), { notificationPermission: 'unsupported' });
    const btn = screen.getByRole('button', { name: /notify n\/a/i });
    expect(btn).toBeDisabled();
  });

  it('requests permission when toggling Notify on while permission=default', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const requestNotificationPermission = vi.fn();
    const updateSettings = vi.fn();

    renderControls(baseSettings({ notificationsOn: false }), {
      notificationPermission: 'default',
      requestNotificationPermission,
      updateSettings,
    });

    await user.click(screen.getByRole('button', { name: /notify off/i }));
    expect(updateSettings).toHaveBeenCalledWith({ notificationsOn: true });
    expect(requestNotificationPermission).toHaveBeenCalled();
  });

  it('does NOT request permission when toggling Notify on while permission=granted', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const requestNotificationPermission = vi.fn();

    renderControls(baseSettings({ notificationsOn: false }), {
      notificationPermission: 'granted',
      requestNotificationPermission,
    });

    await user.click(screen.getByRole('button', { name: /notify off/i }));
    // Permission already granted — no prompt.
    expect(requestNotificationPermission).not.toHaveBeenCalled();
  });

  it('does nothing when clicking a disabled notify button', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const updateSettings = vi.fn();

    renderControls(baseSettings(), {
      notificationPermission: 'denied',
      updateSettings,
    });
    // The debounce effect pre-populates updateSettings on mount with the
    // initial slider state. Clear so we track only the click behaviour.
    updateSettings.mockClear();

    await user.click(screen.getByRole('button', { name: /notify blocked/i }));
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════
// DEBOUNCED SLIDERS
// ══════════════════════════════════════════════════════════

describe('OtmFlowControls — slider debounce', () => {
  it('does not push a slider change immediately — only after 250ms', () => {
    const updateSettings = vi.fn();
    renderControls(baseSettings(), { updateSettings });

    // After mount, the debounce effect runs once with the initial value =>
    // one "no-op" commit. Clear so we can track only subsequent changes.
    updateSettings.mockClear();

    const slider = screen.getByRole('slider', {
      name: /minimum ask-side ratio/i,
    });
    fireEvent.change(slider, { target: { value: '0.8' } });

    // Immediately after the change, no commit yet.
    expect(updateSettings).not.toHaveBeenCalled();

    // Advance past the 250ms debounce window.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(updateSettings).toHaveBeenCalled();
    const lastCall = updateSettings.mock.calls.at(-1)![0] as Record<
      string,
      unknown
    >;
    expect(lastCall.minAskRatio).toBeCloseTo(0.8, 5);
  });

  it('debounces the bid, distance, and premium sliders too', () => {
    const updateSettings = vi.fn();
    renderControls(baseSettings(), { updateSettings });
    updateSettings.mockClear();

    const bid = screen.getByRole('slider', {
      name: /minimum bid-side ratio/i,
    });
    fireEvent.change(bid, { target: { value: '0.85' } });

    const dist = screen.getByRole('slider', {
      name: /minimum absolute distance from spot/i,
    });
    fireEvent.change(dist, { target: { value: '0.012' } });

    const prem = screen.getByRole('slider', { name: /minimum total premium/i });
    fireEvent.change(prem, { target: { value: '200000' } });

    expect(updateSettings).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    // After debounce, one combined commit with all three fields.
    expect(updateSettings).toHaveBeenCalled();
    const lastCall = updateSettings.mock.calls.at(-1)![0] as Record<
      string,
      unknown
    >;
    expect(lastCall.minBidRatio).toBeCloseTo(0.85, 5);
    expect(lastCall.minDistancePct).toBeCloseTo(0.012, 5);
    expect(lastCall.minPremium).toBe(200000);
  });

  it('hydrates local slider state when settings change externally (e.g. resetSettings)', () => {
    const updateSettings = vi.fn();
    const { rerender } = render(
      <OtmFlowControls
        settings={baseSettings({ minAskRatio: 0.6 })}
        updateSettings={updateSettings}
        resetSettings={vi.fn()}
        notificationPermission="default"
        requestNotificationPermission={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('slider', { name: /minimum ask-side ratio/i }),
    ).toHaveValue('0.6');

    // External update — simulate resetSettings pushing a new object.
    rerender(
      <OtmFlowControls
        settings={baseSettings({ minAskRatio: 0.9 })}
        updateSettings={updateSettings}
        resetSettings={vi.fn()}
        notificationPermission="default"
        requestNotificationPermission={vi.fn()}
      />,
    );

    // Advance any debounce that may fire.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(
      screen.getByRole('slider', { name: /minimum ask-side ratio/i }),
    ).toHaveValue('0.9');
  });
});
