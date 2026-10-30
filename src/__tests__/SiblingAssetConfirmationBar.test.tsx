import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { SiblingAssetConfirmationBar } from '../components/Gexbot/SiblingAssetConfirmationBar';
import type { SiblingConfirmRow } from '../hooks/useGexbotData';
import { dealerClaims } from './helpers/dealer-claims';

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

const FIRED_AT = '2026-10-29T14:00:10.000Z';

function makeRow(
  ticker: string,
  verdict: SiblingConfirmRow['verdict'],
  overrides: Partial<SiblingConfirmRow> = {},
): SiblingConfirmRow {
  return {
    ticker,
    verdict,
    netDex: verdict === 'none' ? null : 1_500_000,
    zgr: 0.83,
    capturedAt: '2026-10-29T14:00:00.000Z',
    ...overrides,
  };
}

function loaded(rows: SiblingConfirmRow[]) {
  mockUseGexbotData.mockReturnValue({
    rows,
    loading: false,
    error: null,
    freshestAt: '2026-10-29T14:00:00.000Z',
  });
}

function renderBar(side: 'call' | 'put' = 'call', firedAt = FIRED_AT) {
  return render(
    <SiblingAssetConfirmationBar
      ticker="AAPL"
      side={side}
      firedAt={firedAt}
      marketOpen
    />,
  );
}

describe('<SiblingAssetConfirmationBar>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('asks the hook for the sibling read at the alert fire time', () => {
    loaded([]);
    renderBar('put');
    expect(mockUseGexbotData).toHaveBeenCalledWith(
      { view: 'sibling-confirm', ticker: 'AAPL', side: 'put', at: FIRED_AT },
      true,
    );
  });

  it('normalises an offset fire time to UTC before asking', () => {
    loaded([]);
    renderBar('call', '2026-10-29T09:00:10-05:00');
    expect(mockUseGexbotData.mock.calls[0]?.[0]).toMatchObject({
      at: FIRED_AT,
    });
  });

  it('renders nothing, and never fetches, when the fire time is not a date', () => {
    const { container } = renderBar('call', 'not-a-date');
    expect(container.firstChild).toBeNull();
    expect(mockUseGexbotData).not.toHaveBeenCalled();
  });

  it('renders nothing when loading', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    const { container } = renderBar();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing on error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    const { container } = renderBar();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no siblings returned', () => {
    loaded([]);
    const { container } = renderBar();
    expect(container.firstChild).toBeNull();
  });

  it('renders one pill per sibling with agree and disagree glyphs', () => {
    loaded([
      makeRow('SPY', 'agree'),
      makeRow('QQQ', 'agree'),
      makeRow('IWM', 'disagree'),
    ]);
    renderBar();
    expect(screen.getByTestId('sibling-bar-AAPL-call')).toBeInTheDocument();
    expect(screen.getByTestId('sibling-pill-AAPL-SPY')).toHaveTextContent('✓');
    expect(screen.getByTestId('sibling-pill-AAPL-IWM')).toHaveTextContent('✗');
    expect(screen.getByTestId('sibling-pill-AAPL-SPY')).toHaveAttribute(
      'aria-label',
      'SPY taker flow agrees',
    );
    expect(screen.getByTestId('sibling-pill-AAPL-IWM')).toHaveAttribute(
      'aria-label',
      'IWM taker flow disagrees',
    );
  });

  it('applies emerald to agree and rose to disagree', () => {
    loaded([makeRow('SPY', 'agree'), makeRow('QQQ', 'disagree')]);
    renderBar();
    expect(screen.getByTestId('sibling-pill-AAPL-SPY').className).toMatch(
      /emerald/,
    );
    expect(screen.getByTestId('sibling-pill-AAPL-QQQ').className).toMatch(
      /rose/,
    );
  });

  it('renders a no-data sibling as a dash in the tertiary tone', () => {
    loaded([makeRow('SPY', 'agree'), makeRow('QQQ', 'none')]);
    renderBar();
    const pill = screen.getByTestId('sibling-pill-AAPL-QQQ');
    expect(pill).toHaveTextContent('—');
    expect(pill.className).toMatch(/tertiary/);
    expect(pill).toHaveAttribute('aria-label', 'QQQ taker flow —');
  });

  it('says "no data" once, not per pill, when no sibling has a read', () => {
    loaded([makeRow('SPY', 'none'), makeRow('QQQ', 'none')]);
    renderBar();
    const bar = screen.getByTestId('sibling-bar-AAPL-call');
    expect(bar).toHaveTextContent(/no data/i);
    expect(screen.queryByTestId('sibling-pill-AAPL-SPY')).toBeNull();
  });

  it('puts net_dex, zgr and the unvalidated caveat in the tooltip', () => {
    loaded([makeRow('SPY', 'agree', { netDex: 1_500_000, zgr: 0.83 })]);
    renderBar();
    const title =
      screen.getByTestId('sibling-pill-AAPL-SPY').getAttribute('title') ?? '';
    expect(title).toMatch(/net_dex/);
    expect(title).toMatch(/1\.50M/);
    expect(title).toMatch(/zgr 0\.83/);
    expect(title).toMatch(/context, unvalidated/);
  });

  it('omits null readings from the tooltip', () => {
    loaded([
      makeRow('SPY', 'agree', { netDex: 1_500_000, zgr: null }),
      makeRow('QQQ', 'none', { netDex: null, zgr: null }),
    ]);
    renderBar();
    const spy =
      screen.getByTestId('sibling-pill-AAPL-SPY').getAttribute('title') ?? '';
    expect(spy).toMatch(/net_dex/);
    expect(spy).not.toMatch(/zgr|null|NaN/);
    const qqq =
      screen.getByTestId('sibling-pill-AAPL-QQQ').getAttribute('title') ?? '';
    expect(qqq).not.toMatch(/net_dex|zgr|null|NaN/);
    expect(qqq).toMatch(/context, unvalidated/);
  });

  it('drops futures views and orders siblings like the 14 underlyings', () => {
    loaded([
      makeRow('ES_SPX', 'agree'),
      makeRow('QQQ', 'agree'),
      makeRow('NQ_NDX', 'agree'),
      makeRow('SPY', 'disagree'),
    ]);
    renderBar();
    expect(screen.queryByTestId('sibling-pill-AAPL-ES_SPX')).toBeNull();
    expect(screen.queryByTestId('sibling-pill-AAPL-NQ_NDX')).toBeNull();
    const pills = screen.getAllByTestId(/^sibling-pill-AAPL-/);
    expect(pills.map((p) => p.getAttribute('data-testid'))).toEqual([
      'sibling-pill-AAPL-SPY',
      'sibling-pill-AAPL-QQQ',
    ]);
  });

  it('carries no dealer or market-maker wording', () => {
    loaded([
      makeRow('SPY', 'agree'),
      makeRow('QQQ', 'disagree'),
      makeRow('IWM', 'none'),
    ]);
    const { container } = renderBar();
    const attrs = Array.from(container.querySelectorAll('[title],[aria-label]'))
      .flatMap((el) => [
        el.getAttribute('title'),
        el.getAttribute('aria-label'),
      ])
      .filter(Boolean)
      .join(' ');
    expect(dealerClaims(`${container.textContent ?? ''} ${attrs}`)).toEqual([]);
  });
});
