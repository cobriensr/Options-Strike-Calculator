import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SrHint } from '../../../components/ui/SrHint';

describe('SrHint', () => {
  it('renders the hint inside an sr-only span, led by a dash separator', () => {
    const { container } = render(<SrHint>Tier 2: solid setup.</SrHint>);
    const hint = container.querySelector('span.sr-only');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe(' — Tier 2: solid setup.');
  });

  it('resets text-transform so an uppercase badge does not shout the hint', () => {
    // Badges such as the round-trip pill are `uppercase`. The hint is
    // inside them, so without normal-case it inherits the transform, and a
    // browser exposes the transformed text to a screen reader.
    const { container } = render(
      <span className="uppercase">
        round-tripped -2
        <SrHint>Sellers outweighed buyers.</SrHint>
      </span>,
    );
    const hint = container.querySelector('.sr-only')!;
    expect(hint).toHaveClass('sr-only', 'normal-case');
  });

  it('keeps the hint out of selections so a copied row pastes only visible text', () => {
    // sr-only text is still selectable: copying a contract name out of a row
    // would pick up the hidden sentence. select-none (user-select: none)
    // drops it from the clipboard and leaves the accessibility tree alone.
    const { container } = render(
      <span>
        SPY 727 C<SrHint>Tier 2: solid setup.</SrHint> 05/15
      </span>,
    );
    const hint = container.querySelector('.sr-only')!;
    expect(hint).toHaveClass('sr-only', 'normal-case', 'select-none');
  });

  it('carries no offset class, so its box stays beside the text it explains', () => {
    // sr-only is position: absolute with no offsets, so the hint keeps the
    // static position it would have had in the flow, right after its label.
    // An offset such as top-0 left-0 moves it to the corner of its
    // containing block, which for most rows is the page origin. A screen
    // reader that scrolls to its reading position (VoiceOver on iOS) would
    // then jump to the top of the page at every hint. Inside a horizontal
    // scroller the scroller has to be positioned instead (ScrollHint is);
    // see ui.test.tsx. jsdom has no layout, so this pins the classes and the
    // e2e specs (responsive.spec.ts, narrow-panels.spec.ts) measure
    // scrollWidth.
    const { container } = render(<SrHint>Explains the badge.</SrHint>);
    const hint = container.querySelector('.sr-only')!;
    const offsets = [...hint.classList].filter((name) =>
      /^-?(top|left|right|bottom|inset|inset-x|inset-y|start|end)(-|$)/.test(
        name,
      ),
    );
    expect(offsets).toEqual([]);
  });

  it('keeps the visible label and the hint apart when read in one run', () => {
    // A screen reader reads the badge's text content: the label, then the
    // hint. Without the separator the two would run together ("T2Tier 2...").
    render(
      <span data-testid="badge">
        T2
        <SrHint>Tier 2: solid setup.</SrHint>
      </span>,
    );
    expect(screen.getByTestId('badge').textContent).toBe(
      'T2 — Tier 2: solid setup.',
    );
  });

  it('adds nothing a screen reader skips: no aria-hidden, no aria-label', () => {
    const { container } = render(<SrHint>Explains the badge.</SrHint>);
    const hint = container.querySelector('.sr-only')!;
    expect(hint).not.toHaveAttribute('aria-hidden');
    expect(hint).not.toHaveAttribute('aria-label');
    expect(hint).not.toHaveAttribute('role');
  });

  it('leaves the parent badge out of getByText by its own label', () => {
    // Testing Library matches an element's own text nodes, so a badge that
    // gains a hint child is still found by its visible label.
    render(
      <span>
        Gated
        <SrHint>Counter-trend per OTM Market Tide.</SrHint>
      </span>,
    );
    expect(screen.getByText('Gated')).toBeInTheDocument();
  });
});
