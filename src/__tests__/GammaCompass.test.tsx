import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { GammaCompass } from '../components/Gexbot/GammaCompass';
import type { SnapshotsLatestRow } from '../hooks/useGexbotData';

const mockUseGexbotData = vi.fn();
vi.mock('../hooks/useGexbotData', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useGexbotData')>(
    '../hooks/useGexbotData',
  );
  return {
    ...actual,
    useGexbotData: (...args: unknown[]) => mockUseGexbotData(...args),
  };
});

function makeRow(overrides: Partial<SnapshotsLatestRow>): SnapshotsLatestRow {
  return {
    ticker: 'SPX',
    capturedAt: '2026-05-19T14:00:00Z',
    spot: 5985,
    zeroGamma: 5990,
    zMlgamma: null,
    zMsgamma: null,
    zcvr: null,
    zgr: null,
    zvanna: null,
    zcharm: null,
    oMlgamma: null,
    oMsgamma: null,
    ocvr: null,
    ogr: null,
    ovanna: null,
    ocharm: null,
    dexoflow: null,
    gexoflow: null,
    cvroflow: null,
    oneDexoflow: null,
    oneGexoflow: null,
    oneCvroflow: null,
    deltaRiskReversal: null,
    ...overrides,
  };
}

describe('<GammaCompass>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('shows empty-state when no rows have spot + at least one gamma strike', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPX', spot: 5985, zMlgamma: null, zMsgamma: null }),
      ],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<GammaCompass marketOpen />);
    expect(screen.getByTestId('gamma-compass-empty')).toBeInTheDocument();
  });

  it('shows loading placeholder', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<GammaCompass marketOpen />);
    expect(screen.getByTestId('gamma-compass-loading')).toBeInTheDocument();
  });

  it('shows error when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<GammaCompass marketOpen />);
    expect(screen.getByTestId('gamma-compass-error')).toBeInTheDocument();
  });

  it('renders a row when only floor is set (danger renders as em-dash)', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPX', spot: 5985, zMlgamma: 5950, zMsgamma: null }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<GammaCompass marketOpen />);
    const compass = screen.getByTestId('gamma-compass');
    expect(compass).toHaveTextContent('SPX');
    expect(compass).toHaveTextContent(/5950\.00 \(-35\.00, -0\.58%\)/);
    expect(compass).toHaveTextContent('—');
  });

  it('formats distance with signed delta + percent vs spot', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPX', spot: 5985, zMlgamma: 5950, zMsgamma: 6020 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<GammaCompass marketOpen />);
    const compass = screen.getByTestId('gamma-compass');
    expect(compass).toHaveTextContent(/5950\.00 \(-35\.00, -0\.58%\)/);
    expect(compass).toHaveTextContent(/6020\.00 \(\+35\.00, \+0\.58%\)/);
  });

  it('filters out rows with no spot', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPX', spot: null, zMlgamma: 5950, zMsgamma: 6020 }),
        makeRow({ ticker: 'QQQ', spot: 540, zMlgamma: 532, zMsgamma: 545 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<GammaCompass marketOpen />);
    const compass = screen.getByTestId('gamma-compass');
    // Row identity check: QQQ row renders; SPX row was filtered out so
    // no <td>SPX</td> in the table body.
    const rows = compass.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0]).toHaveTextContent('QQQ');
  });

  it('shows "inverted" badge when long γ strike is above spot', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        // Inverted regime: long γ (6020) is ABOVE spot (5985), short γ
        // (5950) is BELOW. Typical floor/ceiling intuition flipped.
        makeRow({ ticker: 'SPX', spot: 5985, zMlgamma: 6020, zMsgamma: 5950 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<GammaCompass marketOpen />);
    expect(
      screen.getByTestId('gamma-compass-inverted-SPX'),
    ).toBeInTheDocument();
  });

  it('shows "typical" indicator when regime is normal', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPX', spot: 5985, zMlgamma: 5950, zMsgamma: 6020 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    const { container } = render(<GammaCompass marketOpen />);
    expect(
      screen.queryByTestId('gamma-compass-inverted-SPX'),
    ).not.toBeInTheDocument();
    // "typical" appears once in the header subtitle and once in the
    // per-row regime cell. Assert the per-row cell renders by counting.
    const matches = container.querySelectorAll('tbody td:last-child span');
    expect(matches.length).toBe(1);
    expect(matches[0]).toHaveTextContent(/typical/);
  });

  it('uses emerald for floor cells and rose for danger cells', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPX', spot: 5985, zMlgamma: 5950, zMsgamma: 6020 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    const { container } = render(<GammaCompass marketOpen />);
    expect(container.querySelector('td.text-emerald-300')).not.toBeNull();
    expect(container.querySelector('td.text-rose-300')).not.toBeNull();
  });
});
