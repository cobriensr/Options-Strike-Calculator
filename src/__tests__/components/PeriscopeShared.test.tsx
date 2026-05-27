// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  RankedCell,
  Row,
  SectionHeader,
} from '../../components/Periscope/shared';
import type { RankedRow, RankedRowSimple } from '../../types/periscope';

describe('SectionHeader', () => {
  it('renders an h3 with the child text', () => {
    render(<SectionHeader>Gamma</SectionHeader>);
    const header = screen.getByRole('heading', { level: 3 });
    expect(header).toBeInTheDocument();
    expect(header.textContent).toBe('Gamma');
  });

  it('applies the uppercase + tracking-wide section styling', () => {
    render(<SectionHeader>Charm</SectionHeader>);
    const header = screen.getByRole('heading', { level: 3 });
    // The Tailwind classes uppercase + 0.12em tracking are the contract
    // every section relies on for visual rhythm; a regression that
    // dropped them would be silent in unit-of-render terms but loud
    // visually. Pin the class list rather than computed style because
    // jsdom doesn't apply Tailwind.
    expect(header.className).toContain('uppercase');
    expect(header.className).toContain('tracking-[0.12em]');
  });
});

describe('Row', () => {
  it('renders the label on the left and the value on the right', () => {
    render(<Row label="Spot" value={7095.5} />);
    expect(screen.getByText('Spot')).toBeInTheDocument();
    expect(screen.getByText('7095.5')).toBeInTheDocument();
  });

  it('accepts a ReactNode for value (e.g. a styled span)', () => {
    render(
      <Row
        label="Floor"
        value={<span data-testid="rich-value">7080 +200</span>}
      />,
    );
    expect(screen.getByTestId('rich-value')).toBeInTheDocument();
  });

  it('uses justify-between so the row aligns label-left / value-right', () => {
    const { container } = render(<Row label="L" value="V" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('justify-between');
  });
});

describe('RankedCell', () => {
  it('renders strike, signed value, and pts-from-spot for a full RankedRow', () => {
    const row: RankedRow = { strike: 7100, value: 500_000, ptsFromSpot: 5 };
    const { container } = render(<RankedCell row={row} />);
    const text = container.textContent ?? '';
    // strike rendered verbatim
    expect(text).toContain('7100');
    // fmtSigned: 500K bucket → "+500.0K"
    expect(text).toContain('+500.0K');
    // fmtPts wraps pts in parentheses; positive sign included
    expect(text).toContain('(+5)');
  });

  it('omits the (ptsFromSpot) suffix when given a RankedRowSimple', () => {
    const row: RankedRowSimple = { strike: 7080, value: -300_000 };
    const { container } = render(<RankedCell row={row} />);
    expect(screen.getByText('7080')).toBeInTheDocument();
    // No parenthesized pts cell renders. Restrict the check to the
    // component's own subtree so it doesn't catch unrelated content.
    expect(container.textContent ?? '').not.toMatch(/\(.+\)/);
  });

  it('colors the value cell via colorForValue (positive vs negative)', () => {
    // Two cells with opposite signs must paint to different colors so
    // the green/red signal stays useful in the rendered panel.
    const { container: posCt } = render(
      <RankedCell row={{ strike: 7100, value: 500_000, ptsFromSpot: 5 }} />,
    );
    const { container: negCt } = render(
      <RankedCell row={{ strike: 7080, value: -500_000, ptsFromSpot: -5 }} />,
    );

    // Match the value span by its rendered text rather than DOM position —
    // a future wrapper or reordering won't silently misdirect the test.
    const posValueSpan = [...posCt.querySelectorAll('span')].find(
      (s) => s.textContent === '+500.0K',
    );
    const negValueSpan = [...negCt.querySelectorAll('span')].find(
      (s) => s.textContent === '-500.0K',
    );
    expect(posValueSpan?.style.color).toBeTruthy();
    expect(negValueSpan?.style.color).toBeTruthy();
    expect(posValueSpan?.style.color).not.toBe(negValueSpan?.style.color);
  });

  it('renders ptsFromSpot=0 as a present suffix (not collapsed to empty string)', () => {
    // Edge: a row at exactly the spot has ptsFromSpot=0. fmtPts(0) is
    // truthy so the conditional render below it still mounts the
    // muted-text span.
    const row: RankedRow = { strike: 7095, value: 100_000, ptsFromSpot: 0 };
    const { container } = render(<RankedCell row={row} />);
    expect(container.textContent ?? '').toMatch(/\(.+\)/);
  });
});
