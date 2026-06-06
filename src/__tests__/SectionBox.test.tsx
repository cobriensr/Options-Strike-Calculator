import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SectionBox } from '../components/ui/SectionBox';

describe('SectionBox fill mode', () => {
  it('uses h-full + mt-6 by default (page flow)', () => {
    render(
      <SectionBox label="Default Box">
        <div>body</div>
      </SectionBox>,
    );
    const section = screen.getByRole('region', { name: 'Default Box' });
    expect(section).toHaveClass('h-full');
    expect(section).toHaveClass('mt-6');
  });

  it('drops h-full and mt-6 in fill mode (bounded pane)', () => {
    render(
      <SectionBox label="Fill Box" fill>
        <div>body</div>
      </SectionBox>,
    );
    const section = screen.getByRole('region', { name: 'Fill Box' });
    expect(section).not.toHaveClass('h-full');
    expect(section).not.toHaveClass('mt-6');
  });
});
