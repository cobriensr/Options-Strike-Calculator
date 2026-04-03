/**
 * BackToTop — circular button that scrolls to the top of the page.
 *
 * Appears after scrolling past 2 viewport heights.
 * Positioned above the toast container in the bottom-right corner.
 */

import { memo, useCallback, useEffect, useState } from 'react';

const BackToTop = memo(function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let ticking = false;

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        setVisible(window.scrollY > window.innerHeight * 2);
        ticking = false;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="Back to top"
      className={`bg-surface border-edge-strong text-secondary hover:text-primary hover:border-edge-heavy fixed right-4 bottom-16 z-[65] flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-[1.5px] transition-opacity duration-200 ${
        visible
          ? 'pointer-events-auto opacity-100'
          : 'pointer-events-none opacity-0'
      }`}
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M8 12V4M8 4L4 8M8 4l4 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
});

export default BackToTop;
