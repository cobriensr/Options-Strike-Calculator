import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import SectionNav from '../../components/SectionNav';
import type { NavSection } from '../../components/SectionNav';

// ── Fixtures ─────────────────────────────────────────────

const sections: NavSection[] = [
  { id: 'sec-inputs', label: 'Inputs' },
  { id: 'sec-risk', label: 'Risk' },
  { id: 'sec-regime', label: 'Regime' },
];

// ── IntersectionObserver mock ────────────────────────────

let observerCallback: IntersectionObserverCallback;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

beforeEach(() => {
  mockObserve.mockClear();
  mockDisconnect.mockClear();

  vi.stubGlobal(
    'IntersectionObserver',
    class MockIntersectionObserver {
      constructor(cb: IntersectionObserverCallback) {
        observerCallback = cb;
      }
      observe = mockObserve;
      disconnect = mockDisconnect;
      unobserve = vi.fn();
    },
  );

  // Create DOM elements the component looks up via getElementById
  for (const s of sections) {
    if (!document.getElementById(s.id)) {
      const el = document.createElement('section');
      el.id = s.id;
      document.body.appendChild(el);
    }
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================
// RENDERS NAV ELEMENT
// ============================================================

describe('SectionNav: renders nav element', () => {
  it('has aria-label="Page sections"', () => {
    render(<SectionNav sections={sections} />);

    const nav = screen.getByRole('navigation', {
      name: 'Page sections',
    });
    expect(nav).toBeInTheDocument();
  });
});

// ============================================================
// RENDERS ALL SECTION LINKS
// ============================================================

describe('SectionNav: renders all section links', () => {
  it('each section label is visible as a link', () => {
    render(<SectionNav sections={sections} />);

    for (const s of sections) {
      const link = screen.getByRole('link', { name: s.label });
      expect(link).toBeInTheDocument();
    }
  });
});

// ============================================================
// LINKS HAVE CORRECT HREFS
// ============================================================

describe('SectionNav: links have correct hrefs', () => {
  it('each link has href="#${section.id}"', () => {
    render(<SectionNav sections={sections} />);

    for (const s of sections) {
      const link = screen.getByRole('link', { name: s.label });
      expect(link).toHaveAttribute('href', `#${s.id}`);
    }
  });
});

// ============================================================
// RENDERS WITH EMPTY SECTIONS
// ============================================================

describe('SectionNav: renders with empty sections', () => {
  it('no links rendered, nav still present', () => {
    render(<SectionNav sections={[]} />);

    const nav = screen.getByRole('navigation', {
      name: 'Page sections',
    });
    expect(nav).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

// ============================================================
// ACTIVE LINK STYLING
// ============================================================

describe('SectionNav: active link styling', () => {
  it('applies active class when IntersectionObserver fires', () => {
    render(<SectionNav sections={sections} />);

    // Simulate the observer reporting sec-risk as visible
    act(() => {
      observerCallback(
        [
          {
            isIntersecting: true,
            target: { id: 'sec-risk' },
            boundingClientRect: { top: 100 },
          },
        ] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });

    const activeLink = screen.getByRole('link', { name: 'Risk' });
    expect(activeLink.className).toContain('bg-accent-bg');
    expect(activeLink.className).toContain('text-accent');
  });

  it('inactive links have text-tertiary class', () => {
    render(<SectionNav sections={sections} />);

    act(() => {
      observerCallback(
        [
          {
            isIntersecting: true,
            target: { id: 'sec-risk' },
            boundingClientRect: { top: 100 },
          },
        ] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });

    const inactiveLink = screen.getByRole('link', { name: 'Inputs' });
    expect(inactiveLink.className).toContain('text-tertiary');
    expect(inactiveLink.className).not.toContain('bg-accent-bg');
  });

  it('observer is set up for each section element', () => {
    render(<SectionNav sections={sections} />);

    // One observe() call per section that has a DOM element
    expect(mockObserve).toHaveBeenCalledTimes(sections.length);
  });
});
