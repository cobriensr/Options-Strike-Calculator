import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LazySection from '../components/LazySection';

// ============================================================
// LazySection renders identically to GatedSection with gate=true.
// These tests mirror the GatedSection suite to confirm structural
// parity — the LazySection IS the non-gated path of that primitive.
// ============================================================

describe('LazySection: without fallback', () => {
  it('renders the children', () => {
    render(
      <LazySection id="anchor-1" label="Section">
        <div data-testid="payload">payload</div>
      </LazySection>,
    );
    expect(screen.getByTestId('payload')).toBeInTheDocument();
  });

  it('renders the anchor span with the supplied id', () => {
    const { container } = render(
      <LazySection id="my-anchor" label="Section">
        <div>payload</div>
      </LazySection>,
    );
    const anchor = container.querySelector('#my-anchor');
    expect(anchor).not.toBeNull();
    expect(anchor!.tagName).toBe('SPAN');
  });

  it('the anchor span has block + scroll-mt-28 for sticky-header offset', () => {
    const { container } = render(
      <LazySection id="anchor-2" label="Section">
        <div>payload</div>
      </LazySection>,
    );
    const anchor = container.querySelector('#anchor-2');
    expect(anchor!.className).toContain('scroll-mt-28');
    expect(anchor!.className).toContain('block');
  });
});

describe('LazySection: with fallback', () => {
  it('renders synchronous children without showing the fallback', () => {
    render(
      <LazySection
        id="anchor-3"
        label="Section"
        fallback={<div data-testid="loading">loading...</div>}
      >
        <div data-testid="payload">payload</div>
      </LazySection>,
    );
    expect(screen.getByTestId('payload')).toBeInTheDocument();
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
  });

  it('shows the fallback when a child suspends', async () => {
    const neverResolves = new Promise<void>(() => {});
    function Suspending(): React.ReactNode {
      throw neverResolves;
    }
    render(
      <LazySection
        id="anchor-4"
        label="Section"
        fallback={<div data-testid="loading">loading...</div>}
      >
        <Suspending />
      </LazySection>,
    );
    expect(await screen.findByTestId('loading')).toBeInTheDocument();
  });
});
