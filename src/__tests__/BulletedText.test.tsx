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

  it('triggers the legacy whitespace-pre-wrap fallback when input has no bullets and no header lines (empty string)', () => {
    // Legacy fallback (`elements.length === 0`) is only reachable when no
    // line emits an element — i.e. empty string or pure-whitespace input.
    // See known-bug note in src/components/TRACELive/BulletedText.tsx:
    // the fallback's intent ("render legacy paragraph text whole") is
    // unreachable for any non-blank input under the current control flow.
    const { container } = render(<BulletedText text="" />);
    const ps = container.querySelectorAll('p');
    expect(ps).toHaveLength(1);
    expect(ps[0]).toHaveClass('whitespace-pre-wrap');
    expect(ps[0]?.textContent).toBe('');
  });

  it('renders non-bullet, non-blank lines as separate header <p> elements (current behavior)', () => {
    // Documents current behavior — each non-bullet line becomes its own
    // styled header paragraph, even when the caller passed legacy
    // paragraph-form prose. Newlines are NOT preserved, contrary to the
    // file-level comment.
    const { container } = render(
      <BulletedText
        text={'This is a legacy analysis with\nembedded newlines.'}
      />,
    );
    const ps = container.querySelectorAll('p');
    expect(ps).toHaveLength(2);
    expect(ps[0]).toHaveClass('font-semibold');
    expect(ps[0]?.textContent).toBe('This is a legacy analysis with');
    expect(ps[1]?.textContent).toBe('embedded newlines.');
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
