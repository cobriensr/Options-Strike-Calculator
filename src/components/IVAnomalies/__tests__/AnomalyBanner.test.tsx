import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnomalyBanner } from '../AnomalyBanner';
import { ivAnomalyBannerStore } from '../banner-store';
import type { IVAnomalyRow } from '../types';

function makeRow(overrides: Partial<IVAnomalyRow> = {}): IVAnomalyRow {
  return {
    id: 1,
    ticker: 'SPX',
    strike: 7135,
    side: 'put',
    expiry: '2026-04-23',
    spotAtDetect: 7140.5,
    ivAtDetect: 0.225,
    skewDelta: 2.1,
    zScore: 3.2,
    askMidDiv: 0.6,
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
    expect(screen.getByText(/SPX 7135P/)).toBeInTheDocument();
    expect(screen.getByText('skew_delta')).toBeInTheDocument();
    expect(screen.getByText('z_score')).toBeInTheDocument();
    expect(screen.getByText('early')).toBeInTheDocument();
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
      name: /Dismiss SPX 7135 put anomaly/,
    });
    await user.click(button);
    expect(screen.queryByText(/SPX 7135P/)).not.toBeInTheDocument();
  });
});
