/**
 * PeriscopeProse (ProseView) — verifies the markdown rendering pipeline
 * exercises every custom component override (h1/h2/h3, p, strong, ul/ol/li,
 * code, hr, table/thead/th/td) for both the live chat panel and the
 * history detail view.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProseView } from '../components/PeriscopeChat/PeriscopeProse';

describe('ProseView — smoke render', () => {
  it('renders an empty wrapper when prose is empty', () => {
    const { container } = render(<ProseView prose="" />);
    // Outer wrapper still mounts; just no markdown children.
    const wrapper = container.firstElementChild;
    expect(wrapper).not.toBeNull();
    // Default class set covers the rounded card style.
    expect(wrapper!.className).toContain('rounded-md');
    expect(wrapper!.className).toContain('border');
  });

  it('uses the provided className override on the outer card', () => {
    const { container } = render(
      <ProseView prose="hello" className="custom-prose-wrap" />,
    );
    const wrapper = container.firstElementChild;
    expect(wrapper!.className).toBe('custom-prose-wrap');
  });
});

describe('ProseView — heading hierarchy', () => {
  it('renders h1, h2, h3 with the configured Tailwind classes', () => {
    render(
      <ProseView prose={'# Top heading\n\n## Sub heading\n\n### Tertiary'} />,
    );
    const h1 = screen.getByRole('heading', { level: 1 });
    const h2 = screen.getByRole('heading', { level: 2 });
    const h3 = screen.getByRole('heading', { level: 3 });
    expect(h1).toHaveTextContent('Top heading');
    expect(h2).toHaveTextContent('Sub heading');
    expect(h3).toHaveTextContent('Tertiary');
    expect(h1.className).toContain('text-base');
    expect(h2.className).toContain('text-sm');
    expect(h3.className).toContain('uppercase');
  });
});

describe('ProseView — inline formatting', () => {
  it('renders a paragraph with strong (bold) emphasis', () => {
    render(<ProseView prose="A paragraph with **bold** content." />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('bold').className).toContain('font-semibold');
  });

  it('renders inline code with the surface-pill class', () => {
    render(<ProseView prose="Use `sql` carefully." />);
    const code = screen.getByText('sql');
    expect(code.tagName).toBe('CODE');
    expect(code.className).toContain('font-mono');
  });

  it('renders a horizontal rule for ---', () => {
    const { container } = render(
      <ProseView prose={'before\n\n---\n\nafter'} />,
    );
    const hr = container.querySelector('hr');
    expect(hr).not.toBeNull();
    expect(hr!.className).toContain('border-edge');
  });
});

describe('ProseView — lists', () => {
  it('renders an unordered list with custom bullet styling', () => {
    render(<ProseView prose={'- one\n- two\n- three'} />);
    const ul = screen.getByRole('list');
    expect(ul.tagName).toBe('UL');
    expect(ul.className).toContain('list-disc');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('renders an ordered list with list-decimal styling', () => {
    render(<ProseView prose={'1. first\n2. second'} />);
    const ol = screen.getByRole('list');
    expect(ol.tagName).toBe('OL');
    expect(ol.className).toContain('list-decimal');
  });
});

describe('ProseView — GFM tables', () => {
  it('renders a markdown table with thead/th/td styling', () => {
    const md = `| Strike | Note |
|--------|------|
| 5800   | pin  |
| 5810   | wall |`;
    render(<ProseView prose={md} />);
    // Header cells.
    expect(screen.getByText('Strike').tagName).toBe('TH');
    expect(screen.getByText('Note').tagName).toBe('TH');
    // Body cells.
    expect(screen.getByText('5800').tagName).toBe('TD');
    expect(screen.getByText('pin').tagName).toBe('TD');
    expect(screen.getByText('wall').tagName).toBe('TD');
    // Outer wrapper has overflow-x-auto for horizontal scroll on small viewports.
    const tableEl = screen.getByText('5800').closest('table');
    expect(tableEl).not.toBeNull();
    expect(tableEl!.parentElement!.className).toContain('overflow-x-auto');
  });
});
