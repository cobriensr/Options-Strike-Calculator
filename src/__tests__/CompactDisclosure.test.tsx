import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CompactDisclosure } from '../components/ui/CompactDisclosure';

describe('CompactDisclosure', () => {
  it('starts collapsed and hides its children', () => {
    render(
      <CompactDisclosure label="Filters">
        <div>filter body</div>
      </CompactDisclosure>,
    );
    const toggle = screen.getByRole('button', { name: /filters/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('filter body')).not.toBeInTheDocument();
  });

  it('reveals children when expanded, hides again when toggled', () => {
    render(
      <CompactDisclosure label="Filters">
        <div>filter body</div>
      </CompactDisclosure>,
    );
    const toggle = screen.getByRole('button', { name: /filters/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('filter body')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText('filter body')).not.toBeInTheDocument();
  });

  it('honors defaultOpen', () => {
    render(
      <CompactDisclosure label="Filters" defaultOpen>
        <div>filter body</div>
      </CompactDisclosure>,
    );
    expect(screen.getByText('filter body')).toBeInTheDocument();
  });

  it('renders an optional summary node next to the label', () => {
    render(
      <CompactDisclosure label="Filters" summary={<span>3 active</span>}>
        <div>filter body</div>
      </CompactDisclosure>,
    );
    expect(screen.getByText('3 active')).toBeInTheDocument();
  });
});
