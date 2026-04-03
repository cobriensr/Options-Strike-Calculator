/**
 * SectionNav — sticky horizontal navigation below the header.
 *
 * Highlights the currently visible section via IntersectionObserver.
 * Renders anchor links that smooth-scroll to each section.
 */

import { memo, useEffect, useRef, useState } from 'react';

export interface NavSection {
  id: string;
  label: string;
}

interface Props {
  sections: NavSection[];
}

const SectionNav = memo(function SectionNav({ sections }: Props) {
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

  return (
    <nav
      aria-label="Page sections"
      className="border-edge sticky top-[57px] z-40 border-b backdrop-blur-md"
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
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
});

export default SectionNav;
