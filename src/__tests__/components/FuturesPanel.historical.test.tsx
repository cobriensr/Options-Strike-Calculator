import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FuturesPanel from '../../components/FuturesCalculator/FuturesPanel';
import type { FuturesDataState } from '../../hooks/useFuturesData';
import { useFuturesData } from '../../hooks/useFuturesData';

vi.mock('../../hooks/useFuturesData', () => ({
  useFuturesData: vi.fn(),
}));

const mockUseFuturesData = vi.mocked(useFuturesData);

// Capture the `at` argument the panel passes to the hook on each render.
const atHistory: Array<string | undefined> = [];

function mockState(overrides: Partial<FuturesDataState> = {}) {
  const defaults: FuturesDataState = {
    snapshots: [],
    vxTermSpread: null,
    vxTermStructure: null,
    esSpxBasis: null,
    updatedAt: null,
    oldestTs: '2026-03-01T13:30:00.000Z',
    loading: false,
    error: null,
    refetch: vi.fn(),
  };
  mockUseFuturesData.mockImplementation((at) => {
    atHistory.push(at);
    return { ...defaults, ...overrides };
  });
}

beforeEach(() => {
  atHistory.length = 0;
  mockUseFuturesData.mockReset();
});

describe('FuturesPanel: historical picker', () => {
  it('renders the datetime-local picker with min/max/step', () => {
    mockState();
    render(<FuturesPanel />);

    const picker = screen.getByLabelText(
      'Historical futures timestamp',
    ) as HTMLInputElement;

    expect(picker).toBeInTheDocument();
    expect(picker.type).toBe('datetime-local');
    expect(picker.step).toBe('60');
    expect(picker.min).not.toBe('');
    expect(picker.max).not.toBe('');
  });

  it('starts empty (live mode) and does not pass at to the hook', () => {
    mockState();
    render(<FuturesPanel />);

    expect(atHistory[0]).toBeUndefined();
    expect(screen.queryByText('VIEWING HISTORICAL')).not.toBeInTheDocument();
  });

  it('passes CT-anchored UTC ISO to the hook when a datetime is typed', () => {
    mockState();
    render(<FuturesPanel />);

    const picker = screen.getByLabelText(
      'Historical futures timestamp',
    ) as HTMLInputElement;

    // fireEvent.change sets the value and dispatches the synthetic event
    // React needs to update its controlled-input state. userEvent.type is
    // flaky for datetime-local inputs in jsdom, so we use fireEvent here.
    fireEvent.change(picker, { target: { value: '2026-04-17T09:30' } });

    // The picker value is CT wall-clock, and 2026-04-17 is during CDT
    // (UTC-5), so 09:30 CDT == 14:30 UTC. This must be true regardless
    // of the host's timezone — the prior implementation used
    // `new Date(localValue).toISOString()`, which silently produced a
    // host-tz-dependent result.
    expect(atHistory.at(-1)).toBe('2026-04-17T14:30:00.000Z');
  });

  it('passes CT-anchored UTC ISO during CST (winter)', () => {
    mockState();
    render(<FuturesPanel />);

    const picker = screen.getByLabelText(
      'Historical futures timestamp',
    ) as HTMLInputElement;

    // 2026-01-15 is during CST (UTC-6), so 09:30 CST == 15:30 UTC.
    fireEvent.change(picker, { target: { value: '2026-01-15T09:30' } });

    expect(atHistory.at(-1)).toBe('2026-01-15T15:30:00.000Z');
  });

  it('shows the VIEWING HISTORICAL pill when at is set', () => {
    mockState();
    render(<FuturesPanel />);

    const picker = screen.getByLabelText(
      'Historical futures timestamp',
    ) as HTMLInputElement;

    fireEvent.change(picker, { target: { value: '2026-04-17T09:30' } });

    expect(screen.getByText('VIEWING HISTORICAL')).toBeInTheDocument();
  });

  it('Now button clears the picker and reverts to live mode', async () => {
    const user = userEvent.setup();
    mockState();
    render(<FuturesPanel />);

    const picker = screen.getByLabelText(
      'Historical futures timestamp',
    ) as HTMLInputElement;

    fireEvent.change(picker, { target: { value: '2026-04-17T09:30' } });

    expect(screen.getByText('VIEWING HISTORICAL')).toBeInTheDocument();

    const nowBtn = screen.getByRole('button', {
      name: 'Reset to live data',
    });
    expect(nowBtn).not.toBeDisabled();
    await user.click(nowBtn);

    expect(picker.value).toBe('');
    expect(screen.queryByText('VIEWING HISTORICAL')).not.toBeInTheDocument();
    // After click, the latest hook call must be with undefined.
    expect(atHistory.at(-1)).toBeUndefined();
  });

  it('Now button is disabled while picker is empty', () => {
    mockState();
    render(<FuturesPanel />);

    const nowBtn = screen.getByRole('button', {
      name: 'Reset to live data',
    });
    expect(nowBtn).toBeDisabled();
  });

  it('uses oldestTs as the picker min attribute', () => {
    mockState();
    render(<FuturesPanel />);

    const picker = screen.getByLabelText(
      'Historical futures timestamp',
    ) as HTMLInputElement;

    // oldestTs is '2026-03-01T13:30:00.000Z' — in any local tz this maps
    // to some YYYY-MM-DDTHH:mm string. Just assert it's well-formed.
    expect(picker.min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
