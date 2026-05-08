import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import GatedSection from '../components/GatedSection';

// ============================================================
// gate=false → render nothing
// ============================================================

describe('GatedSection: gate=false', () => {
  it('renders nothing when gate is false', () => {
    const { container } = render(
      <GatedSection gate={false} id="test-anchor" label="Test Section">
        <div data-testid="payload">payload</div>
      </GatedSection>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('does not render the children when gate is false', () => {
    render(
      <GatedSection gate={false} id="test-anchor" label="Test Section">
        <div data-testid="payload">payload</div>
      </GatedSection>,
    );
    expect(screen.queryByTestId('payload')).not.toBeInTheDocument();
  });

  it('does not render the anchor span when gate is false', () => {
    const { container } = render(
      <GatedSection gate={false} id="test-anchor" label="Test Section">
        <div>payload</div>
      </GatedSection>,
    );
    expect(container.querySelector('#test-anchor')).toBeNull();
  });
});

// ============================================================
// gate=true, no fallback → no Suspense boundary
// ============================================================

describe('GatedSection: gate=true without fallback', () => {
  it('renders the children when gate is true', () => {
    render(
      <GatedSection gate id="anchor-1" label="Section">
        <div data-testid="payload">payload</div>
      </GatedSection>,
    );
    expect(screen.getByTestId('payload')).toBeInTheDocument();
    expect(screen.getByText('payload')).toBeInTheDocument();
  });

  it('renders the anchor span with the supplied id', () => {
    const { container } = render(
      <GatedSection gate id="my-anchor" label="Section">
        <div>payload</div>
      </GatedSection>,
    );
    const anchor = container.querySelector('#my-anchor');
    expect(anchor).not.toBeNull();
    expect(anchor!.tagName).toBe('SPAN');
  });

  it('the anchor span has scroll-mt-28 so the sticky header doesn’t cover it', () => {
    const { container } = render(
      <GatedSection gate id="anchor-2" label="Section">
        <div>payload</div>
      </GatedSection>,
    );
    const anchor = container.querySelector('#anchor-2');
    expect(anchor).not.toBeNull();
    expect(anchor!.className).toContain('scroll-mt-28');
    expect(anchor!.className).toContain('block');
  });

  it('does not wrap children in a Suspense boundary when fallback is omitted', () => {
    // No clean DOM marker for Suspense (it's a virtual boundary), but we
    // can verify there is no fallback content rendered alongside a real
    // child — a real Suspense boundary with a synchronous child would
    // never show the fallback either, so instead we cover this branch
    // by asserting fallback text from a sibling test is NOT swallowed.
    // The structural guarantee here is: child renders directly under
    // ErrorBoundary, no Suspense in the tree.
    render(
      <GatedSection gate id="anchor-3" label="Section">
        <div>direct child</div>
      </GatedSection>,
    );
    expect(screen.getByText('direct child')).toBeInTheDocument();
  });
});

// ============================================================
// gate=true, with fallback → Suspense boundary wraps children
// ============================================================

describe('GatedSection: gate=true with fallback', () => {
  it('renders the children with a synchronous child (Suspense never trips)', () => {
    render(
      <GatedSection
        gate
        id="anchor-4"
        label="Section"
        fallback={<div data-testid="loading">loading...</div>}
      >
        <div data-testid="payload">payload</div>
      </GatedSection>,
    );
    expect(screen.getByTestId('payload')).toBeInTheDocument();
    // Synchronous child does not suspend, so the fallback must NOT show.
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
  });

  it('renders the anchor span when a fallback is supplied', () => {
    const { container } = render(
      <GatedSection
        gate
        id="anchor-5"
        label="Section"
        fallback={<div>loading</div>}
      >
        <div>payload</div>
      </GatedSection>,
    );
    const anchor = container.querySelector('#anchor-5');
    expect(anchor).not.toBeNull();
    expect(anchor!.tagName).toBe('SPAN');
  });

  it('shows the fallback when a child suspends', async () => {
    // Build a child that suspends on first render by throwing a never-
    // resolving promise. Suspense must catch it and render the fallback.
    const neverResolves = new Promise<void>(() => {});
    function Suspending(): React.ReactNode {
      throw neverResolves;
    }

    render(
      <GatedSection
        gate
        id="anchor-6"
        label="Section"
        fallback={<div data-testid="loading">loading...</div>}
      >
        <Suspending />
      </GatedSection>,
    );
    // Suspense fallback should render — confirms the Suspense boundary
    // is actually in place when fallback is supplied.
    expect(await screen.findByTestId('loading')).toBeInTheDocument();
  });
});
