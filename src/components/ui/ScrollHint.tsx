import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** Wrapper that shows a right-edge fade when content overflows horizontally */
export function ScrollHint({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
  const ref = useRef<HTMLDivElement>(null);
  const [canScroll, setCanScroll] = useState(false);

  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanScroll(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [check]);

  return (
    <div className={className ? `relative ${className}` : 'relative'}>
      <div ref={ref} onScroll={check} className="overflow-x-auto">
        {children}
      </div>
      {canScroll && (
        <div
          className="pointer-events-none absolute top-0 right-0 bottom-0 w-8"
          style={{
            background:
              'linear-gradient(to right, transparent, var(--color-surface))',
          }}
        />
      )}
    </div>
  );
}
