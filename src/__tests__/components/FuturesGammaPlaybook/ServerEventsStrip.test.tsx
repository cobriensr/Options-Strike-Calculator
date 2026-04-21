/**
 * ServerEventsStrip tests — presentation only.
 *
 * The hook is mocked so we can drive each rendering branch (loading,
 * empty, populated, error) directly without involving fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../hooks/useRegimeEventsHistory', () => ({
  useRegimeEventsHistory: vi.fn(),
}));

import { useRegimeEventsHistory } from '../../../hooks/useRegimeEventsHistory';
import { ServerEventsStrip } from '../../../components/FuturesGammaPlaybook/ServerEventsStrip';
import type { RegimeEventRow } from '../../../hooks/useRegimeEventsHistory';

function row(overrides: Partial<RegimeEventRow> = {}): RegimeEventRow {
  return {
    id: 1,
    ts: '2026-04-20T20:00:00.000Z',
    type: 'REGIME_FLIP',
    severity: 'urgent',
    title: 'Regime flip: POSITIVE → NEGATIVE',
    body: 'Net GEX flipped negative.',
    deliveredCount: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(useRegimeEventsHistory).mockReset();
});

describe('ServerEventsStrip', () => {
  it('renders a loading state when first mounting with no events', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [],
      loading: true,
      error: null,
      refresh: vi.fn(),
    });
    render(<ServerEventsStrip marketOpen={true} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/loading/i);
  });

  it('renders the empty state when there are no events', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<ServerEventsStrip marketOpen={true} />);
    expect(screen.getByText(/no server events/i)).toBeInTheDocument();
  });

  it('renders rows for each event with title and type badge', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [
        row({ id: 2, title: 'Regime flip: POSITIVE → NEGATIVE' }),
        row({
          id: 1,
          type: 'LEVEL_BREACH',
          title: 'call wall broken at 5830.00',
        }),
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<ServerEventsStrip marketOpen={true} />);
    expect(
      screen.getByText('Regime flip: POSITIVE → NEGATIVE'),
    ).toBeInTheDocument();
    expect(screen.getByText('call wall broken at 5830.00')).toBeInTheDocument();
    expect(screen.getByText('REGIME')).toBeInTheDocument();
    expect(screen.getByText('BREACH')).toBeInTheDocument();
  });

  it('renders the delivery count when non-zero', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [row({ deliveredCount: 3 })],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<ServerEventsStrip marketOpen={true} />);
    expect(screen.getByText('3x')).toBeInTheDocument();
  });

  it('omits the delivery count when zero', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [row({ deliveredCount: 0 })],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    render(<ServerEventsStrip marketOpen={true} />);
    expect(screen.queryByText(/x$/)).not.toBeInTheDocument();
  });

  it('renders the error message when the hook returns an error', () => {
    vi.mocked(useRegimeEventsHistory).mockReturnValue({
      events: [],
      loading: false,
      error: new Error('Unauthorized — owner session required.'),
      refresh: vi.fn(),
    });
    render(<ServerEventsStrip marketOpen={true} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/unauthorized/i);
  });
});
