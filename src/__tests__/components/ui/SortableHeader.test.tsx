/**
 * SortableHeader primitive tests.
 *
 * Covers the visual + a11y contract that `OptionsFlowTable` and
 * `WhalePositioningTable` previously enforced via copy-pasted local
 * definitions: aria-sort semantics, click forwarding, default + custom
 * alignment, and inactive-column placeholder rendering.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortableHeader } from '../../../components/ui/SortableHeader';

type Col = 'a' | 'b';

function renderHeader(
  props: Partial<{
    label: string;
    sortKey: Col;
    currentKey: Col;
    currentDir: 'asc' | 'desc';
    onSort: (k: Col) => void;
    align: 'left' | 'right' | 'center';
    tooltip: string;
  }> = {},
) {
  const onSort = props.onSort ?? vi.fn();
  return {
    onSort,
    ...render(
      <table>
        <thead>
          <tr>
            <SortableHeader<Col>
              label={props.label ?? 'Premium'}
              sortKey={props.sortKey ?? 'a'}
              currentKey={props.currentKey ?? 'a'}
              currentDir={props.currentDir ?? 'desc'}
              onSort={onSort}
              align={props.align ?? 'right'}
              tooltip={props.tooltip}
            />
          </tr>
        </thead>
      </table>,
    ),
  };
}

describe('SortableHeader', () => {
  it('renders the column label inside a button', () => {
    renderHeader({ label: 'Premium' });
    expect(screen.getByRole('button', { name: /premium/i })).toBeInTheDocument();
  });

  it('aria-sort is "descending" when active and direction is desc', () => {
    renderHeader({
      sortKey: 'a',
      currentKey: 'a',
      currentDir: 'desc',
    });
    const header = screen.getByRole('columnheader');
    expect(header).toHaveAttribute('aria-sort', 'descending');
  });

  it('aria-sort is "ascending" when active and direction is asc', () => {
    renderHeader({
      sortKey: 'a',
      currentKey: 'a',
      currentDir: 'asc',
    });
    const header = screen.getByRole('columnheader');
    expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  it('aria-sort is "none" when this column is not the active sort', () => {
    renderHeader({
      sortKey: 'b',
      currentKey: 'a',
      currentDir: 'desc',
    });
    const header = screen.getByRole('columnheader');
    expect(header).toHaveAttribute('aria-sort', 'none');
  });

  it('forwards the column key to onSort when clicked', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    renderHeader({ sortKey: 'b', currentKey: 'a', onSort });
    await user.click(screen.getByRole('button'));
    expect(onSort).toHaveBeenCalledWith('b');
    expect(onSort).toHaveBeenCalledTimes(1);
  });

  it('applies right alignment by default', () => {
    renderHeader();
    expect(screen.getByRole('columnheader').className).toMatch(/text-right/);
  });

  it('applies left alignment when align="left"', () => {
    renderHeader({ align: 'left' });
    expect(screen.getByRole('columnheader').className).toMatch(/text-left/);
  });

  it('applies center alignment when align="center"', () => {
    renderHeader({ align: 'center' });
    expect(screen.getByRole('columnheader').className).toMatch(/text-center/);
  });

  it('passes the tooltip prop through to the button title attribute', () => {
    renderHeader({ tooltip: 'Aggregate premium today' });
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('title', 'Aggregate premium today');
  });

  it('renders a faint placeholder arrow when this column is not active', () => {
    renderHeader({ sortKey: 'b', currentKey: 'a' });
    // Placeholder is the up-arrow; the active class shouldn't apply to it.
    const indicator = screen
      .getByRole('columnheader')
      .querySelector('span[aria-hidden="true"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toBe('▲');
    expect(indicator?.className).toMatch(/text-muted\/40/);
  });

  it('renders a filled active-color arrow when this column is the active sort', () => {
    renderHeader({
      sortKey: 'a',
      currentKey: 'a',
      currentDir: 'asc',
    });
    const indicator = screen
      .getByRole('columnheader')
      .querySelector('span[aria-hidden="true"]');
    expect(indicator?.textContent).toBe('▲');
    expect(indicator?.className).toMatch(/text-secondary/);
  });

  it('renders a down arrow when active direction is desc', () => {
    renderHeader({
      sortKey: 'a',
      currentKey: 'a',
      currentDir: 'desc',
    });
    const indicator = screen
      .getByRole('columnheader')
      .querySelector('span[aria-hidden="true"]');
    expect(indicator?.textContent).toBe('▼');
  });
});
