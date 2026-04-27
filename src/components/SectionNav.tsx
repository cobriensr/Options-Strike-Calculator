/**
 * SectionNav — IntersectionObserver-driven page navigation.
 *
 * Renders either as a sticky horizontal chip bar (mobile / narrow
 * viewports) or as a vertical sidebar list (desktop), based on the
 * `orientation` prop. The active section is detected via the same
 * IntersectionObserver logic regardless of orientation.
 *
 * App.tsx mounts two instances — one horizontal (visible at < lg) and
 * one vertical (visible at lg+) — and lets responsive display classes
 * pick the right one. Both share the same `sections` array, so the
 * source of truth stays in one place.
 */

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';

export interface NavSection {
  id: string;
  label: string;
}

interface Props {
  sections: NavSection[];
  orientation?: 'horizontal' | 'vertical';
  /** Tailwind class overrides for the outer <nav>. */
  className?: string;
  /**
   * Optional content rendered at the foot of the vertical sidebar (e.g. an
   * access-key button). Ignored in horizontal orientation.
   */
  bottomSlot?: ReactNode;
}

const SectionNav = memo(function SectionNav({
  sections,
  orientation = 'horizontal',
  className,
  bottomSlot,
}: Props) {
  const [activeId, setActiveId] = useState<string>('');
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    observerRef.current?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the topmost visible section
        let best: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            (!best ||
              entry.boundingClientRect.top < best.boundingClientRect.top)
          ) {
            best = entry;
          }
        }
        if (best) setActiveId(best.target.id);
      },
      { rootMargin: '-100px 0px -60% 0px', threshold: 0 },
    );

    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }

    observerRef.current = observer;
    return () => observer.disconnect();
  }, [sections]);

  if (orientation === 'vertical') {
    return (
      <nav
        aria-label="Page sections"
        className={
          className ??
          'border-edge sticky top-[57px] hidden h-[calc(100vh-57px)] w-56 shrink-0 overflow-y-auto border-r px-3 py-4 lg:block'
        }
      >
        <div className="flex flex-col gap-0.5">
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={`rounded-md px-3 py-1.5 font-sans text-[12px] font-semibold tracking-[0.04em] transition-colors duration-100 ${
                activeId === s.id
                  ? 'bg-accent-bg text-accent'
                  : 'text-tertiary hover:text-primary hover:bg-surface-alt'
              }`}
              aria-current={activeId === s.id ? 'location' : undefined}
            >
              {s.label}
            </a>
          ))}
        </div>
        {bottomSlot && (
          <div className="border-edge mt-4 border-t pt-3">{bottomSlot}</div>
        )}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Page sections"
      className={
        className ??
        'border-edge sticky top-[57px] z-40 border-b backdrop-blur-md lg:hidden'
      }
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--color-page) 85%, transparent)',
      }}
    >
      <div className="scrollbar-hide mx-auto flex max-w-[660px] gap-1 overflow-x-auto px-5 py-1.5 lg:max-w-6xl">
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className={`shrink-0 rounded-full px-2.5 py-1 font-sans text-[11px] font-semibold tracking-[0.06em] transition-colors duration-100 ${
              activeId === s.id
                ? 'bg-accent-bg text-accent'
                : 'text-tertiary hover:text-primary hover:bg-surface-alt'
            }`}
            aria-current={activeId === s.id ? 'location' : undefined}
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
});

export default SectionNav;
