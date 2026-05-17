import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { SiblingAssetConfirmationBar } from '../components/Gexbot/SiblingAssetConfirmationBar';
import type { SiblingConfirmRow } from '../hooks/useGexbotData';

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

function makeRow(
  ticker: string,
  verdict: SiblingConfirmRow['verdict'],
  overrides: Partial<SiblingConfirmRow> = {},
): SiblingConfirmRow {
  return {
    ticker,
    verdict,
    zcvr: 1.0,
    deltaRiskReversal: 0,
    ...overrides,
  };
}

describe('<SiblingAssetConfirmationBar>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('renders nothing when loading', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    const { container } = render(
      <SiblingAssetConfirmationBar ticker="AAPL" side="call" marketOpen />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    const { container } = render(
      <SiblingAssetConfirmationBar ticker="AAPL" side="call" marketOpen />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no siblings returned', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    const { container } = render(
      <SiblingAssetConfirmationBar ticker="AAPL" side="call" marketOpen />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one pill per sibling with verdict glyphs', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPY', 'confirm'),
        makeRow('QQQ', 'confirm'),
        makeRow('IWM', 'contradict'),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(
      <SiblingAssetConfirmationBar ticker="AAPL" side="call" marketOpen />,
    );
    expect(screen.getByTestId('sibling-bar-AAPL-call')).toBeInTheDocument();
    expect(screen.getByTestId('sibling-pill-AAPL-SPY')).toHaveTextContent(
      'SPY',
    );
    expect(screen.getByTestId('sibling-pill-AAPL-SPY')).toHaveTextContent('✓');
    expect(screen.getByTestId('sibling-pill-AAPL-IWM')).toHaveTextContent('✗');
  });

  it('applies emerald tone to confirm and rose to contradict', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow('SPY', 'confirm'), makeRow('QQQ', 'contradict')],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(
      <SiblingAssetConfirmationBar ticker="AAPL" side="call" marketOpen />,
    );
    expect(screen.getByTestId('sibling-pill-AAPL-SPY').className).toMatch(
      /emerald/,
    );
    expect(screen.getByTestId('sibling-pill-AAPL-QQQ').className).toMatch(
      /rose/,
    );
  });

  it('renders neutral pills in tertiary tone', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow('SPY', 'neutral')],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(
      <SiblingAssetConfirmationBar ticker="AAPL" side="call" marketOpen />,
    );
    const pill = screen.getByTestId('sibling-pill-AAPL-SPY');
    expect(pill).toHaveTextContent('·');
    expect(pill.className).toMatch(/tertiary/);
  });

  it('includes zcvr + RR in the pill tooltip', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPY', 'confirm', { zcvr: 1.25, deltaRiskReversal: 0.04 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(
      <SiblingAssetConfirmationBar ticker="AAPL" side="call" marketOpen />,
    );
    const pill = screen.getByTestId('sibling-pill-AAPL-SPY');
    expect(pill.getAttribute('title')).toMatch(/zcvr=1\.25/);
    expect(pill.getAttribute('title')).toMatch(/RR=0\.040/);
  });

  it('omits zcvr/RR from tooltip when both are null', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPY', 'neutral', { zcvr: null, deltaRiskReversal: null }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(
      <SiblingAssetConfirmationBar ticker="AAPL" side="call" marketOpen />,
    );
    const pill = screen.getByTestId('sibling-pill-AAPL-SPY');
    const title = pill.getAttribute('title') ?? '';
    expect(title).toBe('SPY neutral');
    expect(title).not.toMatch(/null/);
  });

  it('renders side="put" with rose tone on put-confirm verdict', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPY', 'confirm', { zcvr: 0.8, deltaRiskReversal: -0.03 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<SiblingAssetConfirmationBar ticker="AAPL" side="put" marketOpen />);
    // Bar testid carries side suffix; aria-label reflects "put" too.
    const bar = screen.getByTestId('sibling-bar-AAPL-put');
    expect(bar.getAttribute('aria-label')).toMatch(/put/);
    // verdict-based tone is independent of side (confirm = emerald).
    expect(screen.getByTestId('sibling-pill-AAPL-SPY').className).toMatch(
      /emerald/,
    );
  });
});
