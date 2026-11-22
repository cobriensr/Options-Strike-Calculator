// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IntervalBAAlertBanner from '../components/IntervalBAAlertBanner';
import type { IntervalBAAlert } from '../hooks/useIntervalBAAlerts';
import {
  genericElementsWithAriaLabel,
  srHintText,
  titledGenericsWithoutHint,
} from './helpers/aria';

const sample: IntervalBAAlert = {
  id: 42,
  option_chain: 'SPXW260512C07360000',
  ticker: 'SPXW',
  option_type: 'C',
  strike: 7360,
  expiry: '2026-05-12',
  bucket_start: '2026-05-12T17:05:00.000Z',
  bucket_end: '2026-05-12T17:10:00.000Z',
  fired_at: '2026-05-12T17:06:24.000Z',
  ratio_pct: 71.23,
  ask_premium: 950000,
  total_premium: 1330000,
  trade_count: 5,
  top_trade_premium: 408480,
  top_trade_size: 888,
  top_trade_executed_at: '2026-05-12T17:06:23.000Z',
  top_trade_is_sweep: true,
  top_trade_is_floor: false,
  underlying_price: 7355,
  confluence_tickers: [],
  acknowledged: false,
  severity: 'extreme',
};

describe('IntervalBAAlertBanner', () => {
  it('renders nothing when no unacknowledged alerts', () => {
    const { container } = render(
      <IntervalBAAlertBanner alerts={[]} onAcknowledge={async () => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when all alerts are acknowledged', () => {
    const { container } = render(
      <IntervalBAAlertBanner
        alerts={[{ ...sample, acknowledged: true }]}
        onAcknowledge={async () => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders an alert with derived title and body', () => {
    render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('SPXW 7360C 71% ASK')).toBeInTheDocument();
    expect(
      screen.getByText('$1.33M premium / 5 trades — top: $408K sweep'),
    ).toBeInTheDocument();
  });

  it('shows CALL pill for calls', () => {
    render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
      />,
    );
    expect(screen.getByText('CALL')).toBeInTheDocument();
  });

  it('shows PUT pill for puts', () => {
    render(
      <IntervalBAAlertBanner
        alerts={[{ ...sample, option_type: 'P', id: 100 }]}
        onAcknowledge={async () => {}}
      />,
    );
    expect(screen.getByText('PUT')).toBeInTheDocument();
  });

  it('applies animate-pulse to extreme-severity alerts', () => {
    render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
      />,
    );
    expect(screen.getByRole('alert').className).toContain('animate-pulse');
  });

  it('does not animate warning-severity alerts', () => {
    render(
      <IntervalBAAlertBanner
        alerts={[{ ...sample, severity: 'warning', id: 200 }]}
        onAcknowledge={async () => {}}
      />,
    );
    expect(screen.getByRole('alert').className).not.toContain('animate-pulse');
  });

  it('renders at most 3 alerts and a +N counter for the overflow', () => {
    const four = [1, 2, 3, 4].map((n) => ({ ...sample, id: n }));
    render(
      <IntervalBAAlertBanner alerts={four} onAcknowledge={async () => {}} />,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(screen.getByText('+1 more')).toBeInTheDocument();
  });

  it('calls onAcknowledge with the alert id when dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const ack = vi.fn().mockResolvedValue(undefined);
    render(<IntervalBAAlertBanner alerts={[sample]} onAcknowledge={ack} />);
    await user.click(screen.getByLabelText('Dismiss alert'));
    expect(ack).toHaveBeenCalledWith(42);
  });

  it('renders the +PARTNER pill when confluence_tickers is populated', () => {
    render(
      <IntervalBAAlertBanner
        alerts={[{ ...sample, confluence_tickers: ['SPY', 'QQQ'] }]}
        onAcknowledge={async () => {}}
      />,
    );
    // Alphabetical sort → "+QQQ +SPY".
    expect(screen.getByText('+QQQ +SPY')).toBeInTheDocument();
  });

  it('omits the +PARTNER pill on solo alerts', () => {
    // sample has confluence_tickers=[].
    render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
      />,
    );
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('renders Mute button when onToggleMute is wired and alerts present', () => {
    render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
        muted={false}
        onToggleMute={() => {}}
      />,
    );
    expect(screen.getByLabelText('Mute alerts')).toBeInTheDocument();
    // Alert stack is still visible.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('omits Mute button entirely when onToggleMute is not provided', () => {
    render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
      />,
    );
    expect(screen.queryByLabelText('Mute alerts')).not.toBeInTheDocument();
  });

  it('when muted with pending alerts, collapses to a restore chip', () => {
    render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
        muted={true}
        onToggleMute={() => {}}
      />,
    );
    expect(
      screen.getByLabelText('Unmute alerts (1 pending)'),
    ).toBeInTheDocument();
    // The full alert content is hidden.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('when muted with NO pending alerts, renders nothing', () => {
    const { container } = render(
      <IntervalBAAlertBanner
        alerts={[]}
        onAcknowledge={async () => {}}
        muted={true}
        onToggleMute={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('Mute button click invokes onToggleMute', async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
        muted={false}
        onToggleMute={toggle}
      />,
    );
    await user.click(screen.getByLabelText('Mute alerts'));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('Restore chip click invokes onToggleMute', async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
        muted={true}
        onToggleMute={toggle}
      />,
    );
    await user.click(screen.getByLabelText('Unmute alerts (1 pending)'));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('muted chip renders a dismiss × alongside the restore button, and clicking it hides the chip', async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    const { container } = render(
      <IntervalBAAlertBanner
        alerts={[sample]}
        onAcknowledge={async () => {}}
        muted={true}
        onToggleMute={toggle}
      />,
    );
    expect(
      screen.getByLabelText('Unmute alerts (1 pending)'),
    ).toBeInTheDocument();
    const dismiss = screen.getByLabelText(
      'Hide muted indicator until next mute toggle',
    );
    expect(dismiss).toBeInTheDocument();
    await user.click(dismiss);
    expect(container.firstChild).toBeNull();
    // Dismissing the chip must NOT unmute.
    expect(toggle).not.toHaveBeenCalled();
  });

  it('dismissed chip re-arms when the muted prop toggles', async () => {
    const user = userEvent.setup();
    const props = {
      alerts: [sample],
      onAcknowledge: async () => {},
      onToggleMute: () => {},
    };
    const { container, rerender } = render(
      <IntervalBAAlertBanner {...props} muted={true} />,
    );
    await user.click(
      screen.getByLabelText('Hide muted indicator until next mute toggle'),
    );
    expect(container.firstChild).toBeNull();
    // Unmute then re-mute — the dismiss only lasts until the next toggle.
    rerender(<IntervalBAAlertBanner {...props} muted={false} />);
    rerender(<IntervalBAAlertBanner {...props} muted={true} />);
    expect(
      screen.getByLabelText('Unmute alerts (1 pending)'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Hide muted indicator until next mute toggle'),
    ).toBeInTheDocument();
  });
});

// The pills keep their `title` for mouse hover. A title on a bare span never
// reaches a screen reader, so each pill carries the explanation as a hidden
// hint, its last child. The toast is a `role="alert"`, so a screen reader
// reads every hint on every announcement: each stays short (60 characters).
describe('IntervalBAAlertBanner: hidden hints for the pills', () => {
  const MAX_LIVE_HINT = 60;

  it.each([
    [
      'C' as const,
      'CALL',
      'CALL — ask-side buyers paid up for upside calls. Bullish directional bet.',
      'buyers paid the ask for upside calls, bullish',
    ],
    [
      'P' as const,
      'PUT',
      'PUT — ask-side buyers paid up for downside puts. Bearish directional bet.',
      'buyers paid the ask for downside puts, bearish',
    ],
  ])(
    'explains the %s side pill in a short hidden hint, not an aria-label, and keeps the title',
    (optionType, label, title, hint) => {
      const { container } = render(
        <IntervalBAAlertBanner
          alerts={[{ ...sample, option_type: optionType }]}
          onAcknowledge={async () => {}}
        />,
      );
      const pill = screen.getByText(label);
      expect(srHintText(pill)).toBe(hint);
      expect(srHintText(pill)!.length).toBeLessThanOrEqual(MAX_LIVE_HINT);
      expect(pill).toHaveAttribute('title', title);
      expect(pill).not.toHaveAttribute('aria-label');
      // The hint is inside the announced alert, so it is read with it.
      expect(screen.getByRole('alert')).toContainElement(pill);
      expect(genericElementsWithAriaLabel(container)).toEqual([]);
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    },
  );

  it('explains the confluence pill in a short hidden hint, not an aria-label, and keeps the title', () => {
    const { container } = render(
      <IntervalBAAlertBanner
        alerts={[{ ...sample, confluence_tickers: ['SPY', 'QQQ'] }]}
        onAcknowledge={async () => {}}
      />,
    );
    // The partners are the pill's visible text, so the hint leaves them out.
    const pill = screen.getByText('+QQQ +SPY');
    expect(srHintText(pill)).toBe('same direction within about 90 seconds');
    expect(srHintText(pill)!.length).toBeLessThanOrEqual(MAX_LIVE_HINT);
    expect(pill).toHaveAttribute(
      'title',
      'Cross-symbol confluence — SPY + QQQ fired same-direction within ~90s.',
    );
    expect(pill).not.toHaveAttribute('aria-label');
    expect(screen.getByRole('alert')).toContainElement(pill);
    expect(genericElementsWithAriaLabel(container)).toEqual([]);
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });

  it('gives a solo alert no confluence pill and leaves no titled pill without a hint', () => {
    const { container } = render(
      <IntervalBAAlertBanner
        alerts={[sample, { ...sample, id: 43, option_type: 'P' }]}
        onAcknowledge={async () => {}}
        onToggleMute={() => {}}
      />,
    );
    expect(
      container.querySelector('[title^="Cross-symbol confluence"]'),
    ).toBeNull();
    expect(titledGenericsWithoutHint(container)).toEqual([]);
  });
});
