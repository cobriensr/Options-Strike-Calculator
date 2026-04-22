import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import OtmFlowAlerts from '../../../components/OtmFlowAlerts/OtmFlowAlerts';
import type { OtmFlowAlert } from '../../../types/otm-flow';
import { ToastContext } from '../../../hooks/useToast';

// ── Mocks ──────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// AudioContext mock — the chime fn calls `new AudioContext()`, then invokes
// createGain()/createOscillator() on the instance. Methods live as CLASS
// FIELDS (not prototype methods) so `Object.assign(this, new MockAudioContext())`
// inside the spy wrapper actually copies them; prototype methods would be
// lost.
class MockAudioContext {
  destination = {};
  currentTime = 0;
  createOscillator = () => ({
    type: '',
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  });
  createGain = () => ({
    connect: vi.fn(),
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
  });
  close = vi.fn().mockResolvedValue(undefined);
}
const audioCtorSpy = vi.fn(function (this: MockAudioContext) {
  Object.assign(this, new MockAudioContext());
});
vi.stubGlobal('AudioContext', audioCtorSpy);

// Notification stub with mutable permission state.
const mockNotification = vi.fn(function () {});
Object.defineProperty(mockNotification, 'permission', {
  value: 'default',
  writable: true,
  configurable: true,
});
Object.defineProperty(mockNotification, 'requestPermission', {
  value: vi.fn().mockResolvedValue('granted'),
  configurable: true,
});
vi.stubGlobal('Notification', mockNotification);

// ── Fixtures ───────────────────────────────────────────────

function makeAlert(overrides: Partial<OtmFlowAlert> = {}): OtmFlowAlert {
  return {
    id: 1,
    option_chain: 'SPXW260422C07100000',
    strike: 7100,
    type: 'call',
    created_at: '2026-04-22T15:00:00.000Z',
    price: 2.5,
    underlying_price: 7000,
    total_premium: 125_000,
    total_size: 500,
    volume: 5000,
    open_interest: 1200,
    volume_oi_ratio: 4.17,
    ask_side_ratio: 0.82,
    bid_side_ratio: 0.1,
    distance_from_spot: 100,
    distance_pct: 0.01429,
    moneyness: 0.9859,
    dte_at_alert: 0,
    has_sweep: true,
    has_multileg: false,
    alert_rule: 'RepeatedHits',
    dominant_side: 'ask',
    ...overrides,
  };
}

function respond(alerts: OtmFlowAlert[], mode: 'live' | 'historical' = 'live') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      alerts,
      alert_count: alerts.length,
      last_updated: alerts[0]?.created_at ?? null,
      spot: alerts[0]?.underlying_price ?? null,
      window_minutes: 30,
      mode,
      thresholds: { ask: 0.6, bid: 0.6, distance_pct: 0.005, premium: 50_000 },
    }),
  } as unknown as Response;
}

// ── Lifecycle ──────────────────────────────────────────────

beforeEach(() => {
  mockFetch.mockReset().mockResolvedValue(respond([]));
  audioCtorSpy.mockClear();
  localStorage.clear();
  // Reset Notification permission between tests so toggle flow is clean.
  Object.defineProperty(mockNotification, 'permission', {
    value: 'default',
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  localStorage.clear();
});

// ══════════════════════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════════════════════

describe('OtmFlowAlerts', () => {
  it('renders the collapsible section with the card label', async () => {
    render(<OtmFlowAlerts marketOpen />);
    expect(
      await screen.findByRole('button', { name: /toggle otm flow alerts/i }),
    ).toBeInTheDocument();
  });

  it('shows an empty-state message when no alerts are returned', async () => {
    render(<OtmFlowAlerts marketOpen />);
    await waitFor(() =>
      expect(screen.getByText(/waiting for prints/i)).toBeInTheDocument(),
    );
  });

  it('shows the "market closed" empty-state when marketOpen is false and mode=live', async () => {
    render(<OtmFlowAlerts marketOpen={false} />);
    // Narrow regex — otherwise the `MARKET CLOSED` badge ALSO matches and
    // getByText throws a multi-match error.
    await waitFor(() =>
      expect(
        screen.getByText(/switch to historical to review/i),
      ).toBeInTheDocument(),
    );
  });

  it('renders one row per returned alert', async () => {
    mockFetch.mockResolvedValue(
      respond([
        makeAlert(),
        makeAlert({
          option_chain: 'SPXW260422P06900000',
          strike: 6900,
          type: 'put',
          dominant_side: 'ask',
          ask_side_ratio: 0.9,
          bid_side_ratio: 0.05,
        }),
      ]),
    );

    render(<OtmFlowAlerts marketOpen />);

    await waitFor(() => {
      expect(screen.getByText('7100')).toBeInTheDocument();
      expect(screen.getByText('6900')).toBeInTheDocument();
    });

    expect(screen.getByText(/Bullish load/i)).toBeInTheDocument();
    expect(screen.getByText(/Bearish hedge/i)).toBeInTheDocument();
  });

  it('plays the OTM chime when new alerts arrive and audioOn is true', async () => {
    mockFetch.mockResolvedValue(respond([makeAlert()]));

    render(<OtmFlowAlerts marketOpen />);

    await waitFor(() => {
      expect(screen.getByText('7100')).toBeInTheDocument();
    });
    // Give React another tick to flush the newlyArrived useEffect — the row
    // renders from `alerts` before the `newlyArrived` side-effect settles.
    await waitFor(() => {
      expect(audioCtorSpy).toHaveBeenCalled();
    });
  });

  it('does NOT play the chime when audioOn is false in stored settings', async () => {
    // Seed localStorage with audioOn: false so settings hydrate that way.
    localStorage.setItem(
      'otm-flow-settings.v1',
      JSON.stringify({
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
        audioOn: false,
        notificationsOn: false,
      }),
    );

    mockFetch.mockResolvedValue(respond([makeAlert()]));

    render(<OtmFlowAlerts marketOpen />);

    await waitFor(() => {
      expect(screen.getByText('7100')).toBeInTheDocument();
    });

    // A moment for any side-effects to fire.
    await act(async () => {
      await Promise.resolve();
    });

    expect(audioCtorSpy).not.toHaveBeenCalled();
  });

  it('renders the historical badge when mode=historical', async () => {
    localStorage.setItem(
      'otm-flow-settings.v1',
      JSON.stringify({
        windowMinutes: 30,
        minAskRatio: 0.6,
        minBidRatio: 0.6,
        minDistancePct: 0.005,
        minPremium: 50_000,
        sides: 'both',
        type: 'both',
        mode: 'historical',
        historicalDate: '2026-04-21',
        historicalTime: '10:30',
        audioOn: true,
        notificationsOn: false,
      }),
    );
    mockFetch.mockResolvedValue(respond([], 'historical'));

    render(<OtmFlowAlerts marketOpen={false} />);

    await waitFor(() =>
      expect(screen.getByText('HISTORICAL')).toBeInTheDocument(),
    );
    // In historical mode we do NOT auto-play the chime.
    expect(audioCtorSpy).not.toHaveBeenCalled();
  });

  it('renders the Live / Historical mode toggles', async () => {
    render(<OtmFlowAlerts marketOpen />);

    expect(
      await screen.findByRole('button', { name: /^live$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^historical$/i }),
    ).toBeInTheDocument();
  });

  it('exposes the ask-threshold slider with an accessible label', async () => {
    render(<OtmFlowAlerts marketOpen />);
    const slider = await screen.findByRole('slider', {
      name: /minimum ask-side ratio/i,
    });
    expect(slider).toHaveAttribute('type', 'range');
    expect(slider).toHaveAttribute('min', '0.5');
    expect(slider).toHaveAttribute('max', '0.95');
  });

  it('shows a disabled "Notify blocked" button when Notification.permission is denied', async () => {
    Object.defineProperty(mockNotification, 'permission', {
      value: 'denied',
      writable: true,
      configurable: true,
    });

    render(<OtmFlowAlerts marketOpen />);

    const btn = await screen.findByRole('button', { name: /notify blocked/i });
    expect(btn).toBeDisabled();
  });

  it('surfaces the fetch error in a role=alert region', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);

    render(<OtmFlowAlerts marketOpen />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/error: http 500/i);
  });

  it('fires a browser Notification when permission=granted and audioOn triggers the side-effect', async () => {
    Object.defineProperty(mockNotification, 'permission', {
      value: 'granted',
      writable: true,
      configurable: true,
    });
    mockNotification.mockClear();
    mockFetch.mockResolvedValue(respond([makeAlert()]));
    localStorage.setItem(
      'otm-flow-settings.v1',
      JSON.stringify({
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
        audioOn: false,
        notificationsOn: true,
      }),
    );

    render(<OtmFlowAlerts marketOpen />);

    await waitFor(() => {
      expect(screen.getByText('7100')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mockNotification).toHaveBeenCalled();
    });
    const [title, opts] = mockNotification.mock.calls[0]! as unknown as [
      string,
      { body: string; tag: string },
    ];
    expect(title).toBe('SPXW OTM flow alert');
    expect(opts.body).toMatch(/CALL 7100.*ASK-heavy/);
    expect(opts.tag).toMatch(/^otm-flow-SPXW260422C07100000-/);
  });

  it('appends "+N more" to notification body when multiple alerts arrive', async () => {
    Object.defineProperty(mockNotification, 'permission', {
      value: 'granted',
      writable: true,
      configurable: true,
    });
    mockNotification.mockClear();
    mockFetch.mockResolvedValue(
      respond([
        makeAlert({
          option_chain: 'A',
          strike: 7200,
          created_at: '2026-04-22T15:02:00.000Z',
        }),
        makeAlert({
          option_chain: 'B',
          strike: 7100,
          created_at: '2026-04-22T15:01:00.000Z',
        }),
        makeAlert({
          option_chain: 'C',
          strike: 7000,
          created_at: '2026-04-22T15:00:00.000Z',
        }),
      ]),
    );
    localStorage.setItem(
      'otm-flow-settings.v1',
      JSON.stringify({
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
        audioOn: false,
        notificationsOn: true,
      }),
    );

    render(<OtmFlowAlerts marketOpen />);

    // Wait for a row to render first — proves the hook completed and state
    // committed — then wait for the notification side-effect.
    await waitFor(() => {
      expect(screen.getByText('7200')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mockNotification).toHaveBeenCalled();
    });
    const [, opts] = mockNotification.mock.calls[0]! as unknown as [
      string,
      { body: string },
    ];
    expect(opts.body).toContain('+2 more');
  });

  it('does NOT fire a Notification when permission=default even if notificationsOn=true', async () => {
    Object.defineProperty(mockNotification, 'permission', {
      value: 'default',
      writable: true,
      configurable: true,
    });
    mockNotification.mockClear();
    mockFetch.mockResolvedValue(respond([makeAlert()]));
    localStorage.setItem(
      'otm-flow-settings.v1',
      JSON.stringify({
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
        audioOn: false,
        notificationsOn: true,
      }),
    );

    render(<OtmFlowAlerts marketOpen />);

    await waitFor(() => {
      expect(screen.getByText('7100')).toBeInTheDocument();
    });
    // permission != 'granted' short-circuits before calling new Notification(...)
    expect(mockNotification).not.toHaveBeenCalled();
  });

  it('fires a toast via ToastContext when wrapped in a provider and new alerts arrive', async () => {
    const show = vi.fn();
    mockFetch.mockResolvedValue(respond([makeAlert()]));

    render(
      <ToastContext.Provider value={{ show }}>
        <OtmFlowAlerts marketOpen />
      </ToastContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByText('7100')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(show).toHaveBeenCalled();
    });
    expect(show).toHaveBeenCalledWith('1 new OTM flow alert', 'info');
  });

  it('pluralises the toast message for multiple new alerts', async () => {
    const show = vi.fn();
    mockFetch.mockResolvedValue(
      respond([
        makeAlert({
          option_chain: 'A',
          created_at: '2026-04-22T15:02:00.000Z',
        }),
        makeAlert({
          option_chain: 'B',
          created_at: '2026-04-22T15:01:00.000Z',
        }),
      ]),
    );

    render(
      <ToastContext.Provider value={{ show }}>
        <OtmFlowAlerts marketOpen />
      </ToastContext.Provider>,
    );

    await waitFor(() => {
      expect(show).toHaveBeenCalled();
    });
    expect(show).toHaveBeenCalledWith('2 new OTM flow alerts', 'info');
  });

  it('requests Notification permission when user toggles Notify from off while permission=default', async () => {
    // Start with default permission + notificationsOn=false.
    Object.defineProperty(mockNotification, 'permission', {
      value: 'default',
      writable: true,
      configurable: true,
    });
    const requestPermissionMock = vi.fn().mockResolvedValue('granted');
    Object.defineProperty(mockNotification, 'requestPermission', {
      value: requestPermissionMock,
      configurable: true,
    });

    localStorage.setItem(
      'otm-flow-settings.v1',
      JSON.stringify({
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
        audioOn: false,
        notificationsOn: false,
      }),
    );

    render(<OtmFlowAlerts marketOpen />);

    const btn = await screen.findByRole('button', { name: /notify off/i });
    await act(async () => {
      btn.click();
    });

    expect(requestPermissionMock).toHaveBeenCalled();
  });

  it('shows the audio toggle in the off state when audioOn=false', async () => {
    localStorage.setItem(
      'otm-flow-settings.v1',
      JSON.stringify({
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
        audioOn: false,
        notificationsOn: false,
      }),
    );

    render(<OtmFlowAlerts marketOpen />);

    expect(
      await screen.findByRole('button', { name: /audio off/i }),
    ).toBeInTheDocument();
  });
});
