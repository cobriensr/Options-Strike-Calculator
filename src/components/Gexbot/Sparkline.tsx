/**
 * Sparkline — tiny inline SVG line chart for time-series previews.
 * Pure presentational; no axes, no labels — just the line scaled to
 * the box. Reusable across Gexbot components.
 */

import { memo, useMemo } from 'react';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Stroke color (Tailwind class names won't work in SVG attrs). */
  strokeClass?: string;
  /** Used to space the path; defaults to `currentColor` for inherited tint. */
  strokeColor?: string;
}

function SparklineInner({
  values,
  width = 80,
  height = 28,
  strokeClass,
  strokeColor = 'currentColor',
}: SparklineProps) {
  const path = useMemo(() => {
    if (values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const stepX = width / (values.length - 1);
    return values
      .map((v, i) => {
        const x = i * stepX;
        const y = height - ((v - min) / range) * height;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [values, width, height]);

  if (values.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={strokeClass}
        aria-hidden
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={strokeColor}
          strokeOpacity={0.3}
          strokeDasharray="2 2"
          strokeWidth={1}
        />
      </svg>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={strokeClass}
      aria-hidden
    >
      <path
        d={path}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const Sparkline = memo(SparklineInner);
