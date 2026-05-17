import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { VixDealerStateBadge } from '../components/Gexbot/VixDealerStateBadge';
import type { SnapshotsLatestRow } from '../hooks/useGexbotData';

// Mock the data hook so we drive the badge from synthetic VIX rows.
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

function makeVix(
  overrides: Partial<SnapshotsLatestRow> = {},
): SnapshotsLatestRow {
  return {
    ticker: 'VIX',
    capturedAt: '2026-05-19T14:00:00Z',
    spot: 18.5,
    zeroGamma: 20.0,
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

describe('<VixDealerStateBadge>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('shows the awaiting-data empty state when rows are empty', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<VixDealerStateBadge marketOpen />);
    expect(screen.getByText(/awaiting first GEXBot tick/i)).toBeInTheDocument();
  });

  it('shows a loading placeholder while loading', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<VixDealerStateBadge marketOpen />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders SHORT GAMMA when spot < zero_gamma', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeVix({ spot: 18.5, zeroGamma: 20.0 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<VixDealerStateBadge marketOpen />);
    const badge = screen.getByTestId('vix-dealer-state-badge');
    expect(badge).toHaveTextContent(/SHORT GAMMA/i);
    expect(badge.className).toMatch(/rose/);
  });

  it('renders LONG GAMMA when spot > zero_gamma', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeVix({ spot: 22.0, zeroGamma: 20.0 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<VixDealerStateBadge marketOpen />);
    const badge = screen.getByTestId('vix-dealer-state-badge');
    expect(badge).toHaveTextContent(/LONG GAMMA/i);
    expect(badge.className).toMatch(/emerald/);
  });

  it('falls back to empty state when spot or zero_gamma is null', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeVix({ spot: null, zeroGamma: 20.0 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<VixDealerStateBadge marketOpen />);
    expect(screen.getByText(/awaiting first GEXBot tick/i)).toBeInTheDocument();
  });

  it('surfaces fetch errors', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<VixDealerStateBadge marketOpen />);
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it('ignores non-VIX rows', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeVix({ ticker: 'SPX', spot: 5950, zeroGamma: 6000 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<VixDealerStateBadge marketOpen />);
    expect(screen.getByText(/awaiting first GEXBot tick/i)).toBeInTheDocument();
  });
});
