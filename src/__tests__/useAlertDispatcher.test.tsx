/**
 * useAlertDispatcher — glue between detectAlertEdges and the three
 * delivery channels (toast / Notification / audio) plus localStorage
 * config persistence, cooldown enforcement, and backtest log.
 *
 * Strategy: mock detectAlertEdges so we can drive the hook with a
 * synthetic event sequence, then verify each delivery channel
 * independently via spies on the global Notification class and
 * audio-utils.getAudioContextCtor.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Mock } from 'vitest';

vi.mock('../utils/futures-gamma/alerts', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/futures-gamma/alerts')>(
      '../utils/futures-gamma/alerts',
    );
  return { ...actual, detectAlertEdges: vi.fn() };
});

vi.mock('../utils/audio-utils', () => ({
  getAudioContextCtor: vi.fn(),
}));

import { useAlertDispatcher } from '../components/FuturesGammaPlaybook/useAlertDispatcher';
import type { UseAlertDispatcherInput } from '../components/FuturesGammaPlaybook/useAlertDispatcher';
import { detectAlertEdges } from '../utils/futures-gamma/alerts';
import { getAudioContextCtor } from '../utils/audio-utils';
import {
  ToastContext,
  type ToastContextValue,
} from '../hooks/useToast';
import type {
  AlertEvent,
  AlertState,
} from '../utils/futures-gamma/alerts';

const mockedDetect = detectAlertEdges as unknown as Mock;
const mockedGetAudioCtor = getAudioContextCtor as unknown as Mock;

// ============================================================
// HELPERS
// ============================================================

const LS_KEY = 'futures-playbook-alerts-v1';

function makeState(
  overrides: Partial<AlertState> = {},
): AlertState {
  return {
    regime: 'POSITIVE',
    phase: 'MORNING',
    levels: [],
    firedTriggers: [],
    esPrice: 5800,
    ...overrides,
  } as AlertState;
}

function makeEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'REGIME_FLIP::2026-04-27T14:30:00Z',
    type: 'REGIME_FLIP',
    title: 'Regime flip POSITIVE → NEGATIVE',
    body: 'ES rolled into −γ',
    severity: 'warn',
    ts: '2026-04-27T14:30:00Z',
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<UseAlertDispatcherInput> = {},
): UseAlertDispatcherInput {
  return {
    state: makeState(),
    isLive: true,
    ...overrides,
  };
}

function makeAudioMock() {
  const close = vi.fn().mockResolvedValue(undefined);
  const osc = {
    type: '',
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = { gain: { value: 0 }, connect: vi.fn() };
  const ctx = {
    currentTime: 0,
    destination: {} as unknown,
    createOscillator: vi.fn(() => osc),
    createGain: vi.fn(() => gain),
    close,
  };
  class MockCtor {
    constructor() {
      return ctx;
    }
  }
  return { ctx, osc, gain, MockCtor };
}

function ToastWrapper(toastFn: Mock) {
  const ctx: ToastContextValue = { show: toastFn };
  return ({ children }: { children: ReactNode }) => (
    <ToastContext.Provider value={ctx}>{children}</ToastContext.Provider>
  );
}

// ============================================================
// SETUP / TEARDOWN
// ============================================================

beforeEach(() => {
  mockedDetect.mockReset();
  mockedDetect.mockReturnValue([]); // default: no events
  mockedGetAudioCtor.mockReset();
  mockedGetAudioCtor.mockReturnValue(undefined);
  window.localStorage.clear();
  // Reset Notification permission for each test.
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// CONFIG PERSISTENCE
// ============================================================

describe('useAlertDispatcher — config', () => {
  it('returns the default config when localStorage is empty', () => {
    const { result } = renderHook(() => useAlertDispatcher(makeInput()));
    expect(result.current.config.enabled).toBe(true);
    expect(result.current.config.toast).toBe(true);
    expect(result.current.config.notification).toBe(false);
    expect(result.current.config.audio).toBe(false);
  });

  it('reads a stored config and merges it with defaults', () => {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({ audio: true, types: { REGIME_FLIP: false } }),
    );
    const { result } = renderHook(() => useAlertDispatcher(makeInput()));
    expect(result.current.config.audio).toBe(true);
    // Untouched keys fall back to defaults.
    expect(result.current.config.toast).toBe(true);
    // Per-type overrides merge into the default types object.
    expect(result.current.config.types.REGIME_FLIP).toBe(false);
    expect(result.current.config.types.LEVEL_APPROACH).toBe(true);
  });

  it('falls back to defaults when stored JSON is malformed', () => {
    window.localStorage.setItem(LS_KEY, '{not json');
    const { result } = renderHook(() => useAlertDispatcher(makeInput()));
    expect(result.current.config.enabled).toBe(true);
  });

  it('persists setConfig to localStorage', () => {
    const { result } = renderHook(() => useAlertDispatcher(makeInput()));
    act(() => {
      result.current.setConfig({ ...result.current.config, audio: true });
    });
    const raw = window.localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).audio).toBe(true);
  });

  it('swallows localStorage write errors (quota exceeded / private mode)', () => {
    const { result } = renderHook(() => useAlertDispatcher(makeInput()));
    const origSetItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = vi.fn(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() =>
      act(() => {
        result.current.setConfig({
          ...result.current.config,
          audio: true,
        });
      }),
    ).not.toThrow();
    // Restore so afterEach cleanup works.
    window.localStorage.setItem = origSetItem;
  });
});

// ============================================================
// NOTIFICATION PERMISSION
// ============================================================

describe('useAlertDispatcher — notification permission', () => {
  it('reports "unsupported" when Notification API is missing', () => {
    const { result } = renderHook(() => useAlertDispatcher(makeInput()));
    expect(result.current.permission).toBe('unsupported');
  });

  it('reports the current permission when Notification API exists', () => {
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      writable: true,
      value: { permission: 'granted', requestPermission: vi.fn() },
    });
    const { result } = renderHook(() => useAlertDispatcher(makeInput()));
    expect(result.current.permission).toBe('granted');
  });

  it('updates permission after requestNotificationPermission resolves', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      writable: true,
      value: { permission: 'default', requestPermission },
    });
    const { result } = renderHook(() => useAlertDispatcher(makeInput()));
    await act(async () => {
      await result.current.requestNotificationPermission();
    });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(result.current.permission).toBe('granted');
  });

  it('falls back to "unsupported" when requestNotificationPermission throws', async () => {
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { result } = renderHook(() => useAlertDispatcher(makeInput()));
    await act(async () => {
      await result.current.requestNotificationPermission();
    });
    expect(result.current.permission).toBe('unsupported');
  });
});

// ============================================================
// EVENT DELIVERY — TOAST
// ============================================================

describe('useAlertDispatcher — toast delivery', () => {
  it('shows an info toast for warn/info severity', () => {
    mockedDetect.mockReturnValueOnce([makeEvent({ severity: 'info' })]);
    const toast = vi.fn();
    renderHook(() => useAlertDispatcher(makeInput()), {
      wrapper: ToastWrapper(toast),
    });
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('Regime flip'),
      'info',
    );
  });

  it('shows an error toast for urgent severity', () => {
    mockedDetect.mockReturnValueOnce([
      makeEvent({ severity: 'urgent' }),
    ]);
    const toast = vi.fn();
    renderHook(() => useAlertDispatcher(makeInput()), {
      wrapper: ToastWrapper(toast),
    });
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('does not crash when no ToastContext provider is present', () => {
    mockedDetect.mockReturnValueOnce([makeEvent()]);
    expect(() =>
      renderHook(() => useAlertDispatcher(makeInput())),
    ).not.toThrow();
  });

  it('skips toast delivery when config.toast is false', () => {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({ toast: false }),
    );
    mockedDetect.mockReturnValueOnce([makeEvent()]);
    const toast = vi.fn();
    renderHook(() => useAlertDispatcher(makeInput()), {
      wrapper: ToastWrapper(toast),
    });
    expect(toast).not.toHaveBeenCalled();
  });
});

// ============================================================
// EVENT DELIVERY — NOTIFICATION
// ============================================================

describe('useAlertDispatcher — Notification delivery', () => {
  it('fires a Notification when permission=granted and config.notification=true', () => {
    type NotificationCtorMock = Mock<
      (title: string, options?: NotificationOptions) => { close: () => void }
    >;
    const NotificationMock = vi.fn(() => ({
      close: vi.fn(),
    })) as unknown as NotificationCtorMock;
    (NotificationMock as unknown as { permission: string }).permission =
      'granted';
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      writable: true,
      value: NotificationMock,
    });
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({ notification: true }),
    );
    mockedDetect.mockReturnValueOnce([makeEvent()]);
    renderHook(() => useAlertDispatcher(makeInput()));
    expect(NotificationMock).toHaveBeenCalledOnce();
    expect(NotificationMock.mock.calls[0]![0]).toMatch(/Regime flip/);
  });

  it('does not fire a Notification when permission!=granted', () => {
    const NotificationMock = vi.fn();
    (NotificationMock as unknown as { permission: string }).permission =
      'denied';
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      writable: true,
      value: NotificationMock,
    });
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({ notification: true }),
    );
    mockedDetect.mockReturnValueOnce([makeEvent()]);
    renderHook(() => useAlertDispatcher(makeInput()));
    expect(NotificationMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// EVENT DELIVERY — AUDIO
// ============================================================

describe('useAlertDispatcher — audio delivery', () => {
  it('plays a tone via the AudioContext when config.audio is true', () => {
    const { ctx, osc, MockCtor } = makeAudioMock();
    mockedGetAudioCtor.mockReturnValue(MockCtor);
    window.localStorage.setItem(LS_KEY, JSON.stringify({ audio: true }));
    mockedDetect.mockReturnValueOnce([makeEvent({ severity: 'urgent' })]);

    renderHook(() => useAlertDispatcher(makeInput()));

    expect(osc.start).toHaveBeenCalled();
    // urgent → 1040 Hz per the playAlertTone severity map.
    expect(osc.frequency.value).toBe(1040);
    expect(osc.stop).toHaveBeenCalledWith(ctx.currentTime + 0.2);
  });

  it('uses 880 Hz for warn severity', () => {
    const { osc, MockCtor } = makeAudioMock();
    mockedGetAudioCtor.mockReturnValue(MockCtor);
    window.localStorage.setItem(LS_KEY, JSON.stringify({ audio: true }));
    mockedDetect.mockReturnValueOnce([makeEvent({ severity: 'warn' })]);

    renderHook(() => useAlertDispatcher(makeInput()));
    expect(osc.frequency.value).toBe(880);
  });

  it('uses 660 Hz for info severity', () => {
    const { osc, MockCtor } = makeAudioMock();
    mockedGetAudioCtor.mockReturnValue(MockCtor);
    window.localStorage.setItem(LS_KEY, JSON.stringify({ audio: true }));
    mockedDetect.mockReturnValueOnce([makeEvent({ severity: 'info' })]);

    renderHook(() => useAlertDispatcher(makeInput()));
    expect(osc.frequency.value).toBe(660);
  });

  it('silently no-ops when AudioContext is unavailable', () => {
    mockedGetAudioCtor.mockReturnValue(undefined);
    window.localStorage.setItem(LS_KEY, JSON.stringify({ audio: true }));
    mockedDetect.mockReturnValueOnce([makeEvent()]);
    expect(() =>
      renderHook(() => useAlertDispatcher(makeInput())),
    ).not.toThrow();
  });

  it('skips audio when config.audio is false (default)', () => {
    const { osc, MockCtor } = makeAudioMock();
    mockedGetAudioCtor.mockReturnValue(MockCtor);
    mockedDetect.mockReturnValueOnce([makeEvent()]);
    renderHook(() => useAlertDispatcher(makeInput()));
    expect(osc.start).not.toHaveBeenCalled();
  });
});

// ============================================================
// COOLDOWNS
// ============================================================

describe('useAlertDispatcher — cooldowns', () => {
  it('suppresses a duplicate event within the cooldown window', () => {
    mockedDetect
      .mockReturnValueOnce([makeEvent({ ts: '2026-04-27T14:30:00Z' })])
      .mockReturnValueOnce([makeEvent({ ts: '2026-04-27T14:30:30Z' })]);
    const toast = vi.fn();
    const { rerender } = renderHook(
      (input: UseAlertDispatcherInput) => useAlertDispatcher(input),
      {
        wrapper: ToastWrapper(toast),
        initialProps: makeInput(),
      },
    );
    // Force a re-fire by handing in a new state object.
    rerender(makeInput({ state: makeState({ esPrice: 5801 }) }));
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('honors a custom per-type cooldown when set', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T14:00:00Z'));
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({ cooldownSeconds: { REGIME_FLIP: 1 } }),
    );
    mockedDetect
      .mockReturnValueOnce([makeEvent()])
      .mockReturnValueOnce([makeEvent({ ts: '2026-04-27T14:00:02Z' })]);
    const toast = vi.fn();
    const { rerender } = renderHook(
      (input: UseAlertDispatcherInput) => useAlertDispatcher(input),
      {
        wrapper: ToastWrapper(toast),
        initialProps: makeInput(),
      },
    );
    // Advance past the 1-second cooldown.
    vi.setSystemTime(new Date('2026-04-27T14:00:02Z'));
    rerender(makeInput({ state: makeState({ esPrice: 5802 }) }));
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it('keeps separate cooldown buckets per LEVEL_APPROACH subkey', () => {
    mockedDetect.mockReturnValueOnce([
      makeEvent({
        type: 'LEVEL_APPROACH',
        id: 'LEVEL_APPROACH:CALL_WALL:t1',
        title: 'Approaching call wall',
      }),
      makeEvent({
        type: 'LEVEL_APPROACH',
        id: 'LEVEL_APPROACH:PUT_WALL:t1',
        title: 'Approaching put wall',
      }),
    ]);
    const toast = vi.fn();
    renderHook(() => useAlertDispatcher(makeInput()), {
      wrapper: ToastWrapper(toast),
    });
    // Both should fire — different subkeys → different cooldown buckets.
    expect(toast).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// PER-TYPE FILTER + ENABLED FLAG
// ============================================================

describe('useAlertDispatcher — config gates', () => {
  it('skips delivery when config.enabled is false', () => {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({ enabled: false }),
    );
    mockedDetect.mockReturnValueOnce([makeEvent()]);
    const toast = vi.fn();
    renderHook(() => useAlertDispatcher(makeInput()), {
      wrapper: ToastWrapper(toast),
    });
    expect(toast).not.toHaveBeenCalled();
    // detectAlertEdges still wasn't called (early return before edge work).
    expect(mockedDetect).not.toHaveBeenCalled();
  });

  it('skips events whose type is disabled in config.types', () => {
    window.localStorage.setItem(
      LS_KEY,
      JSON.stringify({ types: { REGIME_FLIP: false } }),
    );
    mockedDetect.mockReturnValueOnce([makeEvent({ type: 'REGIME_FLIP' })]);
    const toast = vi.fn();
    renderHook(() => useAlertDispatcher(makeInput()), {
      wrapper: ToastWrapper(toast),
    });
    expect(toast).not.toHaveBeenCalled();
  });
});

// ============================================================
// BACKTEST MODE
// ============================================================

describe('useAlertDispatcher — backtest mode', () => {
  it('records events to backtestAlerts when isLive is false', () => {
    mockedDetect.mockReturnValueOnce([makeEvent()]);
    const toast = vi.fn();
    const { result } = renderHook(
      () => useAlertDispatcher(makeInput({ isLive: false })),
      { wrapper: ToastWrapper(toast) },
    );
    expect(result.current.backtestAlerts).toHaveLength(1);
    // No live delivery channels fire in backtest.
    expect(toast).not.toHaveBeenCalled();
  });

  it('clearBacktestAlerts empties the log', () => {
    mockedDetect.mockReturnValueOnce([makeEvent()]);
    const { result } = renderHook(() =>
      useAlertDispatcher(makeInput({ isLive: false })),
    );
    expect(result.current.backtestAlerts.length).toBeGreaterThan(0);
    act(() => result.current.clearBacktestAlerts());
    expect(result.current.backtestAlerts).toHaveLength(0);
  });

  it('caps the backtest log at 100 entries (FIFO eviction)', async () => {
    // Configure 101 distinct timestamps so cooldown doesn't suppress.
    const events = Array.from({ length: 101 }, (_, i) =>
      makeEvent({
        type: 'LEVEL_APPROACH',
        id: `LEVEL_APPROACH:K${i}:t`, // unique subkey per event → unique cooldown bucket
        ts: `2026-04-27T14:${String(i).padStart(2, '0')}:00Z`,
        title: `Approach ${i}`,
      }),
    );
    // Hand each event back on its own re-fire so all 101 get processed
    // through the cooldown filter independently.
    mockedDetect.mockImplementation(() => []);
    const { result, rerender } = renderHook(
      (input: UseAlertDispatcherInput) => useAlertDispatcher(input),
      { initialProps: makeInput({ isLive: false }) },
    );
    for (let i = 0; i < 101; i++) {
      mockedDetect.mockReturnValueOnce([events[i]!]);
      rerender(
        makeInput({
          isLive: false,
          state: makeState({ esPrice: 5800 + i }),
        }),
      );
    }
    expect(result.current.backtestAlerts).toHaveLength(100);
    // First event should have been evicted; last one is still present.
    expect(result.current.backtestAlerts[0]?.id).toBe(
      'LEVEL_APPROACH:K1:t',
    );
    expect(result.current.backtestAlerts.at(-1)?.id).toBe(
      'LEVEL_APPROACH:K100:t',
    );
  });

  it('uses a separate cooldown bucket from live mode', () => {
    // First call (backtest) → suppresses a second call within window.
    mockedDetect
      .mockReturnValueOnce([makeEvent()])
      .mockReturnValueOnce([
        makeEvent({ ts: '2026-04-27T14:30:30Z' }),
      ]);
    const { result, rerender } = renderHook(
      (input: UseAlertDispatcherInput) => useAlertDispatcher(input),
      { initialProps: makeInput({ isLive: false }) },
    );
    rerender(
      makeInput({ isLive: false, state: makeState({ esPrice: 5801 }) }),
    );
    // Two raw events but cooldown deduped → 1 logged.
    expect(result.current.backtestAlerts).toHaveLength(1);
  });
});
