import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnomalyBanner } from '../AnomalyBanner';
import { ivAnomalyBannerStore } from '../banner-store';
import type { IVAnomalyRow } from '../types';

function makeRow(overrides: Partial<IVAnomalyRow> = {}): IVAnomalyRow {
  return {
    id: 1,
    ticker: 'SPXW',
    strike: 7135,
    side: 'put',
    expiry: '2026-04-23',
    spotAtDetect: 7140.5,
    ivAtDetect: 0.225,
    skewDelta: 2.1,
    zScore: 3.2,
    askMidDiv: 0.6,
    volOiRatio: 48.5,
    sideSkew: 0.78,
    sideDominant: 'ask',
    flagReasons: ['skew_delta', 'z_score'],
    flowPhase: 'early',
    contextSnapshot: null,
    resolutionOutcome: null,
    ts: '2026-04-23T15:30:00Z',
    ...overrides,
  };
}

describe('AnomalyBanner', () => {
  beforeEach(() => {
    ivAnomalyBannerStore.__resetForTests();
  });
  afterEach(() => {
    ivAnomalyBannerStore.__resetForTests();
  });

  it('renders nothing when no banners are in the stack', () => {
    const { container } = render(<AnomalyBanner />);
    expect(container.textContent ?? '').toBe('');
  });

  it('renders a card for a pushed anomaly', () => {
    render(<AnomalyBanner />);
    act(() => {
      ivAnomalyBannerStore.push(makeRow({ id: 1 }));
    });
    expect(screen.getByText(/SPXW 7135P/)).toBeInTheDocument();
    expect(screen.getByText('skew_delta')).toBeInTheDocument();
    expect(screen.getByText('z_score')).toBeInTheDocument();
    expect(screen.getByText('early')).toBeInTheDocument();
    // Entry banners show the "New IV anomaly" heading.
    expect(screen.getByText(/New IV anomaly/)).toBeInTheDocument();
  });

  it('renders an exit banner with "Holders exiting" + reason subtitle', () => {
    render(<AnomalyBanner />);
    act(() => {
      ivAnomalyBannerStore.push(makeRow({ id: 7 }), {
        kind: 'exit',
        exitReason: 'iv_regression',
      });
    });
    expect(screen.getByText(/Holders exiting/)).toBeInTheDocument();
    expect(screen.getByText(/IV regressing from peak/)).toBeInTheDocument();
    // Exit banner uses the dedicated test-id.
    expect(screen.getByTestId('banner-exit')).toBeInTheDocument();
  });

  it('differentiates exit vs entry via data-kind attr', () => {
    render(<AnomalyBanner />);
    act(() => {
      ivAnomalyBannerStore.push(makeRow({ id: 1 }), { kind: 'entry' });
      ivAnomalyBannerStore.push(makeRow({ id: 2 }), {
        kind: 'exit',
        exitReason: 'bid_side_surge',
      });
    });
    const entryCard = screen.getByTestId('banner-entry');
    const exitCard = screen.getByTestId('banner-exit');
    expect(entryCard.getAttribute('data-kind')).toBe('entry');
    expect(exitCard.getAttribute('data-kind')).toBe('exit');
    expect(screen.getByText(/Bid-side volume surge/)).toBeInTheDocument();
  });

  it('shows +N more when more than 3 anomalies pushed', () => {
    render(<AnomalyBanner />);
    act(() => {
      for (let i = 1; i <= 5; i += 1) {
        ivAnomalyBannerStore.push(makeRow({ id: i }));
      }
    });
    expect(screen.getByText(/\+2 more anomalies/)).toBeInTheDocument();
  });

  it('uses the singular suffix for exactly one overflow', () => {
    render(<AnomalyBanner />);
    act(() => {
      for (let i = 1; i <= 4; i += 1) {
        ivAnomalyBannerStore.push(makeRow({ id: i }));
      }
    });
    expect(screen.getByText(/\+1 more anomaly/)).toBeInTheDocument();
  });

  it('dismisses a banner on click', async () => {
    const user = userEvent.setup();
    render(<AnomalyBanner />);
    act(() => {
      ivAnomalyBannerStore.push(makeRow({ id: 42 }));
    });
    const button = screen.getByRole('button', {
      name: /Dismiss SPXW 7135 put anomaly/,
    });
    await user.click(button);
    expect(screen.queryByText(/SPXW 7135P/)).not.toBeInTheDocument();
  });
});
