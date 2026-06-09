/**
 * DataAgeBadge unit tests — the always-on Central-Time snapshot-freshness
 * label in the Greek Heatmap header. Asserts it renders the formatted CT
 * time for a valid ISO `asOf`, and renders nothing for null or unparseable
 * input (so we never show "as of  CT" with an empty time).
 *
 * To stay DST/clock-stable, the valid-input test asserts against
 * formatTimeCT(theIso) rather than a hardcoded wall-clock string.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DataAgeBadge } from '../components/GreekHeatmap/DataAgeBadge';
import { formatTimeCT } from '../utils/component-formatters';

describe('DataAgeBadge', () => {
  it('renders "as of {time} CT" with a non-empty CT time for a valid ISO asOf', () => {
    const iso = '2026-06-09T18:45:00Z';
    const { container } = render(<DataAgeBadge asOf={iso} />);

    const expectedTime = formatTimeCT(iso);
    expect(expectedTime).not.toBe('');

    const badge = screen.getByTitle('Snapshot timestamp (Central Time)');
    expect(badge.textContent).toContain('as of');
    expect(badge.textContent).toContain('CT');
    expect(badge.textContent).toContain(expectedTime);
    // Sanity: full label matches exactly.
    expect(container.textContent).toBe(`as of ${expectedTime} CT`);
  });

  it('renders nothing when asOf is null', () => {
    const { container } = render(<DataAgeBadge asOf={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when asOf is an unparseable string', () => {
    const { container } = render(<DataAgeBadge asOf="not-a-date" />);
    expect(container).toBeEmptyDOMElement();
  });
});
