import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VixTermStructure from '../../components/FuturesCalculator/VixTermStructure';
import type {
  LiveVixTermReading,
  VixTermReading,
  VixTermStructureData,
} from '../../hooks/useFuturesData';

// ── Fixtures ──────────────────────────────────────────────

// 15:42 UTC on 2026-10-01 = 10:42 AM CT (CDT).
const LIVE: LiveVixTermReading = {
  vix: 16.5,
  vix3m: 18.6,
  ratio: 0.887,
  band: 'CONTANGO',
  asOf: '2026-10-01T15:42:00.000Z',
};

const CLOSE: VixTermReading = {
  vix: 16.39,
  vix3m: 18.58,
  ratio: 0.882,
  band: 'CONTANGO',
};

function term(
  overrides: Partial<VixTermStructureData> = {},
): VixTermStructureData {
  return {
    live: LIVE,
    lastClose: CLOSE,
    futuresRegime: 'CONTANGO',
    ...overrides,
  };
}

// ============================================================
// EMPTY / DEGRADED
// ============================================================

describe('VixTermStructure: empty and degraded data', () => {
  it('renders nothing when the term structure is null (historical view)', () => {
    const { container } = render(<VixTermStructure vixTermStructure={null} />);

    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when every source is unavailable', () => {
    const { container } = render(
      <VixTermStructure
        vixTermStructure={{ live: null, lastClose: null, futuresRegime: null }}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('falls back to the latest close when there is no live quote', () => {
    render(<VixTermStructure vixTermStructure={term({ live: null })} />);

    expect(screen.getByText('16.39')).toBeInTheDocument();
    expect(screen.getByText('18.58')).toBeInTheDocument();
    expect(screen.getByText('0.882')).toBeInTheDocument();
    expect(
      screen.getByText('Latest daily close (no live quote)'),
    ).toBeInTheDocument();
    // The close is already the headline — no separate "Last close" note.
    expect(screen.queryByText(/^Last close/)).not.toBeInTheDocument();
  });

  it('shows only the VX futures label when it is the only reading', () => {
    render(
      <VixTermStructure
        vixTermStructure={{
          live: null,
          lastClose: null,
          futuresRegime: 'BACKWARDATION',
        }}
      />,
    );

    expect(screen.getByText('VX futures: BACKWARDATION')).toBeInTheDocument();
    expect(screen.queryByText('Ratio')).not.toBeInTheDocument();
    // No ratio band → no badge.
    expect(screen.queryByText('BACKWARDATION')).not.toBeInTheDocument();
  });
});

// ============================================================
// LIVE READING
// ============================================================

describe('VixTermStructure: live reading', () => {
  it('shows live VIX, VIX3M and the ratio to 3 decimals', () => {
    render(<VixTermStructure vixTermStructure={term()} />);

    expect(screen.getByText('VIX')).toBeInTheDocument();
    expect(screen.getByText('VIX3M')).toBeInTheDocument();
    expect(screen.getByText('16.50')).toBeInTheDocument();
    expect(screen.getByText('18.60')).toBeInTheDocument();
    expect(screen.getByText('0.887')).toBeInTheDocument();
    expect(screen.getByText('VIX / VIX3M')).toBeInTheDocument();
  });

  it('labels the live source with its quote time in CT', () => {
    render(<VixTermStructure vixTermStructure={term()} />);

    expect(screen.getByText('Live · 10:42 AM CT')).toBeInTheDocument();
  });

  it('shows the latest close ratio and the VX futures label as context', () => {
    render(<VixTermStructure vixTermStructure={term()} />);

    expect(screen.getByText('Last close 0.882 (CONTANGO)')).toBeInTheDocument();
    expect(screen.getByText('VX futures: CONTANGO')).toBeInTheDocument();
  });

  it('labels a live reading with an unparseable time as just Live', () => {
    render(
      <VixTermStructure
        vixTermStructure={term({ live: { ...LIVE, asOf: 'garbage' } })}
      />,
    );

    expect(screen.getByText('Live')).toBeInTheDocument();
  });
});

// ============================================================
// BAND BADGE
// ============================================================

describe('VixTermStructure: band badge', () => {
  it.each(['CONTANGO', 'FLAT', 'BACKWARDATION'] as const)(
    'shows the %s badge from the live band',
    (band) => {
      render(
        <VixTermStructure
          vixTermStructure={term({
            live: { ...LIVE, band },
            lastClose: null,
            futuresRegime: null,
          })}
        />,
      );

      expect(screen.getByText(band)).toBeInTheDocument();
      // Live-only: no close to show as context.
      expect(screen.queryByText(/^Last close/)).not.toBeInTheDocument();
    },
  );

  it('takes the badge from the latest close when there is no live quote', () => {
    render(
      <VixTermStructure
        vixTermStructure={{
          live: null,
          lastClose: {
            vix: 28,
            vix3m: 25,
            ratio: 1.12,
            band: 'BACKWARDATION',
          },
          futuresRegime: null,
        }}
      />,
    );

    expect(screen.getByText('BACKWARDATION')).toBeInTheDocument();
    expect(screen.getByText('1.120')).toBeInTheDocument();
    expect(
      screen.getByText('Latest daily close (no live quote)'),
    ).toBeInTheDocument();
  });

  it('prefers the live band over the latest close', () => {
    render(
      <VixTermStructure
        vixTermStructure={term({
          live: { ...LIVE, vix: 19, vix3m: 20, ratio: 0.95, band: 'FLAT' },
          futuresRegime: null,
        })}
      />,
    );

    // Badge = FLAT (live); CONTANGO only appears inside the close note.
    expect(screen.getByText('FLAT')).toBeInTheDocument();
    expect(screen.queryByText('CONTANGO')).not.toBeInTheDocument();
    expect(screen.getByText('Last close 0.882 (CONTANGO)')).toBeInTheDocument();
  });
});

// ============================================================
// ACCESSIBILITY
// ============================================================

describe('VixTermStructure: accessibility', () => {
  it('has role=status with accessible label', () => {
    render(<VixTermStructure vixTermStructure={term()} />);

    expect(
      screen.getByRole('status', { name: 'VIX term structure' }),
    ).toBeInTheDocument();
  });

  it('shows VIX Term Structure heading text', () => {
    render(<VixTermStructure vixTermStructure={term()} />);

    expect(screen.getByText('VIX Term Structure')).toBeInTheDocument();
  });
});
