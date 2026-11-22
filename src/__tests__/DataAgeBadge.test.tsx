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
import {
  srHintText,
  titledGenericsWithoutHint,
  visibleText,
} from './helpers/aria';

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
    // Sanity: the full visible label matches exactly. The hidden hint after it
    // is not part of what is shown.
    expect(visibleText(container)).toBe(`as of ${expectedTime} CT`);
  });

  // The title is mouse-only on a span, so a hidden hint says the same thing
  // to a screen reader, after the visible label. It names what the time is,
  // which the label ("as of 10:05 CT") leaves out.
  it('says what the time is in a hidden hint, and keeps the title', () => {
    const { container } = render(<DataAgeBadge asOf="2026-06-09T18:45:00Z" />);
    const badge = screen.getByTitle('Snapshot timestamp (Central Time)');
    expect(srHintText(badge)).toBe('snapshot time, Central Time');
    expect(badge).toHaveAttribute('title', 'Snapshot timestamp (Central Time)');
    expect(badge).not.toHaveAttribute('aria-label');
    expect(titledGenericsWithoutHint(container)).toEqual([]);
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
