/**
 * Tests for MinuteScrubber's prev/next stepper behavior.
 *
 * Two stepping modes:
 *   1. Discrete walk through `availableMinutes` when non-empty (lands
 *      always on a minute that has data).
 *   2. Continuous ±1-minute walk when `availableMinutes` is empty
 *      (relies on the API's at-or-before resolution to land on the
 *      closest available slot).
 *
 * The slider + LIVE reset button behaviour is exercised indirectly
 * through the parent's StrikeBattleMap tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MinuteScrubber } from '../../components/StrikeBattleMap/MinuteScrubber';

describe('MinuteScrubber stepper — discrete walk via availableMinutes', () => {
  const available = [540, 570, 600, 630, 660]; // 9:00, 9:30, 10:00, 10:30, 11:00 CT

  it('next steps to the next available minute strictly greater than current', () => {
    const onChange = vi.fn();
    render(
      <MinuteScrubber
        value={600}
        onChange={onChange}
        liveAvailable={false}
        availableMinutes={available}
      />,
    );
    fireEvent.click(screen.getByLabelText('Next minute'));
    expect(onChange).toHaveBeenCalledWith(630);
  });

  it('prev steps to the previous available minute strictly less than current', () => {
    const onChange = vi.fn();
    render(
      <MinuteScrubber
        value={600}
        onChange={onChange}
        liveAvailable={false}
        availableMinutes={available}
      />,
    );
    fireEvent.click(screen.getByLabelText('Previous minute'));
    expect(onChange).toHaveBeenCalledWith(570);
  });

  it('disables next when current equals the last available minute', () => {
    render(
      <MinuteScrubber
        value={660}
        onChange={vi.fn()}
        liveAvailable={false}
        availableMinutes={available}
      />,
    );
    const nextBtn = screen.getByLabelText('Next minute') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it('disables prev when current equals the first available minute', () => {
    render(
      <MinuteScrubber
        value={540}
        onChange={vi.fn()}
        liveAvailable={false}
        availableMinutes={available}
      />,
    );
    const prevBtn = screen.getByLabelText(
      'Previous minute',
    ) as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
  });

  it('snaps to nearest valid step when current is between available minutes', () => {
    // current = 615 (10:15) is BETWEEN 600 and 630.
    // prev should land on 600 (largest available < 615).
    // next should land on 630 (smallest available > 615).
    const onChange = vi.fn();
    render(
      <MinuteScrubber
        value={615}
        onChange={onChange}
        liveAvailable={false}
        availableMinutes={available}
      />,
    );
    fireEvent.click(screen.getByLabelText('Previous minute'));
    expect(onChange).toHaveBeenLastCalledWith(600);
    fireEvent.click(screen.getByLabelText('Next minute'));
    expect(onChange).toHaveBeenLastCalledWith(630);
  });

  it('when value is null and availableMinutes is non-empty, prev steps from the last available minute', () => {
    // null means "latest" — same anchor as the rightmost available.
    const onChange = vi.fn();
    render(
      <MinuteScrubber
        value={null}
        onChange={onChange}
        liveAvailable
        availableMinutes={available}
      />,
    );
    fireEvent.click(screen.getByLabelText('Previous minute'));
    expect(onChange).toHaveBeenCalledWith(630);
  });
});

describe('MinuteScrubber stepper — continuous walk fallback', () => {
  it('next steps by +1 minute when availableMinutes is empty', () => {
    const onChange = vi.fn();
    render(
      <MinuteScrubber value={600} onChange={onChange} liveAvailable={false} />,
    );
    fireEvent.click(screen.getByLabelText('Next minute'));
    expect(onChange).toHaveBeenCalledWith(601);
  });

  it('prev steps by −1 minute when availableMinutes is empty', () => {
    const onChange = vi.fn();
    render(
      <MinuteScrubber value={600} onChange={onChange} liveAvailable={false} />,
    );
    fireEvent.click(screen.getByLabelText('Previous minute'));
    expect(onChange).toHaveBeenCalledWith(599);
  });

  it('disables prev at the 8:30 CT session-open clamp', () => {
    render(
      <MinuteScrubber value={510} onChange={vi.fn()} liveAvailable={false} />,
    );
    const prevBtn = screen.getByLabelText(
      'Previous minute',
    ) as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
  });

  it('disables next at the 15:00 CT session-close clamp', () => {
    render(
      <MinuteScrubber value={900} onChange={vi.fn()} liveAvailable={false} />,
    );
    const nextBtn = screen.getByLabelText('Next minute') as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });
});

describe('MinuteScrubber stepper — keyboard navigation', () => {
  it('ArrowRight in the stepper group fires next', () => {
    const onChange = vi.fn();
    render(
      <MinuteScrubber
        value={600}
        onChange={onChange}
        liveAvailable={false}
        availableMinutes={[540, 570, 600, 630, 660]}
      />,
    );
    const group = screen.getByRole('group', { name: 'Snapshot stepper' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(630);
  });

  it('ArrowLeft in the stepper group fires prev', () => {
    const onChange = vi.fn();
    render(
      <MinuteScrubber
        value={600}
        onChange={onChange}
        liveAvailable={false}
        availableMinutes={[540, 570, 600, 630, 660]}
      />,
    );
    const group = screen.getByRole('group', { name: 'Snapshot stepper' });
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith(570);
  });

  it('ArrowRight is a no-op when canNext is false', () => {
    const onChange = vi.fn();
    render(
      <MinuteScrubber
        value={660}
        onChange={onChange}
        liveAvailable={false}
        availableMinutes={[540, 570, 600, 630, 660]}
      />,
    );
    const group = screen.getByRole('group', { name: 'Snapshot stepper' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
