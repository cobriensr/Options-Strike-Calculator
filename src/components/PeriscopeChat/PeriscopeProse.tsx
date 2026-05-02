/**
 * Shared markdown renderer for Periscope prose. Used by both the live
 * chat panel (rendering Claude's response) and the history detail
 * panel (rendering a saved past response). Same component map ensures
 * the two views look identical.
 *
 * Tailwind component overrides target the elements Claude actually
 * produces in periscope reads: ATX headings, bold/italic, lists, GFM
 * tables, inline code, and horizontal rules. The styling matches
 * `src/components/ChartAnalysis/AnalysisResults.tsx` so users moving
 * between the two sections aren't visually jarred.
 */

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';

const COMPONENTS = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="text-primary mt-1 mb-2 text-base font-semibold">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="text-primary mt-3 mb-1.5 text-sm font-semibold">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="text-secondary mt-2 mb-1 text-xs font-semibold tracking-wide uppercase">
      {children}
    </h3>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="text-secondary my-1.5 text-xs leading-relaxed">{children}</p>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="text-primary font-semibold">{children}</strong>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="my-1.5 ml-4 list-disc space-y-0.5 text-xs">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="my-1.5 ml-4 list-decimal space-y-0.5 text-xs">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="text-secondary leading-relaxed">{children}</li>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <code className="bg-surface text-primary rounded px-1 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  ),
  hr: () => <hr className="border-edge my-3" />,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-edge min-w-full border text-[11px]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => (
    <thead className="bg-surface/60">{children}</thead>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="border-edge text-primary border px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border-edge text-secondary border px-2 py-1">{children}</td>
  ),
};

const PLUGINS = [remarkGfm];

interface ProseViewProps {
  /** Raw markdown source from Claude. JSON code block already stripped. */
  prose: string;
  /** Optional className override on the outer card. */
  className?: string;
}

export function ProseView({ prose, className }: ProseViewProps) {
  return (
    <div
      className={className ?? 'border-edge bg-surface/40 rounded-md border p-3'}
    >
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {prose}
      </Markdown>
    </div>
  );
}
