import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BulletedText from '../components/TRACELive/BulletedText';

describe('BulletedText', () => {
  it('renders a single bullet group as one <ul>', () => {
    const { container } = render(
      <BulletedText text={'- first point\n- second point'} />,
    );
    const lists = container.querySelectorAll('ul');
    expect(lists).toHaveLength(1);
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('first point');
    expect(items[1]?.textContent).toBe('second point');
  });

  it('renders header lines as paragraphs above their bullets', () => {
    const { container } = render(
      <BulletedText
        text={'STEP 1 — GAMMA\n- gamma point\nSTEP 2 — DELTA\n- delta point'}
      />,
    );
    const headers = container.querySelectorAll('p');
    expect(headers).toHaveLength(2);
    expect(headers[0]?.textContent).toBe('STEP 1 — GAMMA');
    expect(headers[1]?.textContent).toBe('STEP 2 — DELTA');
    expect(container.querySelectorAll('ul')).toHaveLength(2);
  });

  it('treats a blank line as a bullet-group flush', () => {
    const { container } = render(
      <BulletedText text={'- group A item 1\n\n- group B item 1'} />,
    );
    // Two separate <ul> groups separated by blank line.
    expect(container.querySelectorAll('ul')).toHaveLength(2);
  });

  it('renders the empty string as a single empty whitespace-pre-wrap paragraph', () => {
    const { container } = render(<BulletedText text="" />);
    const ps = container.querySelectorAll('p');
    expect(ps).toHaveLength(1);
    expect(ps[0]).toHaveClass('whitespace-pre-wrap');
    expect(ps[0]?.textContent).toBe('');
  });

  it('renders legacy paragraph-form text (no bullet markers) as a single paragraph with newlines preserved', () => {
    // Contract from the file-level docstring: input with no "- " bullet
    // markers anywhere is treated as legacy prose and rendered whole via
    // whitespace-pre-wrap. Earlier versions of the component fragmented
    // every non-bullet line into a styled header <p>; this test locks in
    // the fix.
    render(
      <BulletedText
        text={'This is a legacy analysis with\nembedded newlines.'}
      />,
    );
    const p = screen.getByText(/legacy analysis/);
    expect(p.tagName).toBe('P');
    expect(p).toHaveClass('whitespace-pre-wrap');
    // Text node preserves the embedded newline (whitespace-pre-wrap renders it).
    expect(p.textContent).toBe(
      'This is a legacy analysis with\nembedded newlines.',
    );
  });

  it('strips the leading "- " marker from each bullet', () => {
    render(<BulletedText text={'- alpha\n-   beta with extra spaces'} />);
    expect(screen.getByText('alpha')).toBeInTheDocument();
    // Only the literal "- " (dash + single space) is stripped — extra
    // leading spaces are preserved as part of the content.
    expect(screen.getByText(/^\s*beta with extra spaces$/)).toBeInTheDocument();
  });

  it('trims whitespace on each line before classification', () => {
    const { container } = render(
      <BulletedText text={'   - leading whitespace bullet'} />,
    );
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    expect(container.querySelector('li')?.textContent).toBe(
      'leading whitespace bullet',
    );
  });

  it('handles a trailing blank line without crashing', () => {
    const { container } = render(<BulletedText text={'- a\n- b\n'} />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });
});
