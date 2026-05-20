import { theme } from '../../themes';

/**
 * Inline SVG sparkline of gamma_dir trajectory. Pure path, no deps.
 * Width is 100% (responsive); height is fixed for predictable layout.
 */
export default function Sparkline({
  points,
  color,
}: {
  points: Array<{ gammaDirM: number }>;
  color: string;
}) {
  const W = 200;
  const H = 36;
  if (points.length < 2) {
    return (
      <div
        className="text-tertiary font-sans text-[10px] italic"
        style={{ height: H }}
      >
        no trajectory data
      </div>
    );
  }
  const ys = points.map((p) => p.gammaDirM);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 0);
  const span = Math.max(1, maxY - minY);
  const dx = W / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * dx;
      const y = H - ((p.gammaDirM - minY) / span) * H;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  // Zero baseline
  const zeroY = H - ((0 - minY) / span) * H;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block w-full"
      style={{ height: H }}
      role="img"
      aria-label="Dealer gamma_dir intraday trajectory"
    >
      <line
        x1={0}
        x2={W}
        y1={zeroY}
        y2={zeroY}
        stroke={theme.borderStrong}
        strokeDasharray="2 2"
        strokeWidth={0.5}
      />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
