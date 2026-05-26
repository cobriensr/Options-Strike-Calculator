import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

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

import { GexbotSection } from '../components/Gexbot';

describe('<GexbotSection>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
  });

  it('renders without crashing with marketOpen=true', () => {
    const { container } = render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(container.firstChild).not.toBeNull();
  });

  it('renders without crashing with marketOpen=false', () => {
    const { container } = render(
      <GexbotSection marketOpen={false} spxSpot={null} />,
    );
    expect(container.firstChild).not.toBeNull();
  });

  it('shows the section label', () => {
    render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(screen.getByText(/GEXBot Dealer State/i)).toBeInTheDocument();
  });

  it('mounts all 7 child components (drives empty-state testids)', () => {
    render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(
      screen.getByTestId('dealer-state-summary-strip-empty'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('strike-mover-ladder-empty')).toBeInTheDocument();
    expect(screen.getByTestId('charm-clock-empty')).toBeInTheDocument();
    expect(screen.getByTestId('gamma-compass-empty')).toBeInTheDocument();
    expect(screen.getByTestId('dexoflow-tape-empty')).toBeInTheDocument();
    expect(screen.getByTestId('convexity-matrix-empty')).toBeInTheDocument();
    expect(screen.getByTestId('skew-dashboard-empty')).toBeInTheDocument();
  });

  it('forwards marketOpen=false to the data hook for each child', () => {
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    const calls = mockUseGexbotData.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]).toBe(false);
    }
  });

  it('renders the trial-context footnote', () => {
    render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(screen.getByText(/GEXBot Orderflow-tier data/i)).toBeInTheDocument();
  });
});
