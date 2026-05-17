import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { CrossAssetSkewDashboard } from '../components/Gexbot/CrossAssetSkewDashboard';
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

describe('<CrossAssetSkewDashboard>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('shows empty-state when no ticker has a non-zero risk reversal', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', deltaRiskReversal: null })],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<CrossAssetSkewDashboard marketOpen />);
    expect(screen.getByTestId('skew-dashboard-empty')).toBeInTheDocument();
  });

  it('shows loading placeholder', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<CrossAssetSkewDashboard marketOpen />);
    expect(screen.getByTestId('skew-dashboard-loading')).toBeInTheDocument();
  });

  it('shows error when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<CrossAssetSkewDashboard marketOpen />);
    expect(screen.getByTestId('skew-dashboard-error')).toBeInTheDocument();
  });

  it('renders all 16 bars in fixed order', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', deltaRiskReversal: 0.05 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<CrossAssetSkewDashboard marketOpen />);
    const tickers = [
      'SPX',
      'ES_SPX',
      'NDX',
      'NQ_NDX',
      'RUT',
      'VIX',
      'SPY',
      'QQQ',
      'IWM',
      'TLT',
      'GLD',
      'USO',
      'TQQQ',
      'UVXY',
      'HYG',
      'SLV',
    ];
    for (const t of tickers) {
      expect(screen.getByTestId(`skew-bar-${t}`)).toBeInTheDocument();
    }
  });

  it('renders positive bars in emerald above the zero line', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', deltaRiskReversal: 0.05 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    const { container } = render(<CrossAssetSkewDashboard marketOpen />);
    const spxBar = container.querySelector('[data-testid="skew-bar-SPX"]');
    expect(spxBar?.querySelector('.bg-emerald-400\\/70')).not.toBeNull();
  });

  it('renders negative bars in rose below the zero line', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'VIX', deltaRiskReversal: -0.03 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    const { container } = render(<CrossAssetSkewDashboard marketOpen />);
    const vixBar = container.querySelector('[data-testid="skew-bar-VIX"]');
    expect(vixBar?.querySelector('.bg-rose-400\\/70')).not.toBeNull();
  });

  it('scales bar heights relative to the largest absolute value', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPX', deltaRiskReversal: 0.04 }),
        makeRow({ ticker: 'VIX', deltaRiskReversal: -0.08 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    const { container } = render(<CrossAssetSkewDashboard marketOpen />);
    const spxBar = container
      .querySelector('[data-testid="skew-bar-SPX"]')
      ?.querySelector('.bg-emerald-400\\/70') as HTMLElement | null;
    const vixBar = container
      .querySelector('[data-testid="skew-bar-VIX"]')
      ?.querySelector('.bg-rose-400\\/70') as HTMLElement | null;
    expect(spxBar).not.toBeNull();
    expect(vixBar).not.toBeNull();
    // VIX magnitude is 2x SPX, so its bar height should be larger.
    const spxHeight = Number.parseFloat(spxBar!.style.height);
    const vixHeight = Number.parseFloat(vixBar!.style.height);
    expect(vixHeight).toBeGreaterThan(spxHeight);
  });

  it('forwards marketOpen=false to the data hook', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', deltaRiskReversal: 0.05 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<CrossAssetSkewDashboard marketOpen={false} />);
    const lastCall = mockUseGexbotData.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(false);
  });

  it('distinguishes "no data" from "RR exactly 0" via aria-label', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPX', deltaRiskReversal: 0 }),
        // VIX intentionally absent from rows
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<CrossAssetSkewDashboard marketOpen />);
    const spxBar = screen.getByTestId('skew-bar-SPX');
    const vixBar = screen.getByTestId('skew-bar-VIX');
    expect(spxBar.getAttribute('aria-label')).toMatch(/SPX risk reversal/);
    expect(vixBar.getAttribute('aria-label')).toMatch(/VIX no data/);
  });
});
