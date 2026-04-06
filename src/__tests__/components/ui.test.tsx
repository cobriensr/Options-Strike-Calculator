import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  SectionBox,
  Chip,
  ScrollHint,
  StatusBadge,
  ErrorMsg,
} from '../../components/ui';

describe('SectionBox', () => {
  it('renders label and children', () => {
    render(<SectionBox label="Test Section">Content here</SectionBox>);
    expect(screen.getByLabelText('Test Section')).toBeInTheDocument();
    expect(screen.getByText('Content here')).toBeInTheDocument();
  });

  it('renders badge when provided', () => {
    render(
      <SectionBox label="Sec" badge="v2">
        Child
      </SectionBox>,
    );
    expect(screen.getByText('v2')).toBeInTheDocument();
  });

  it('does not render badge when null', () => {
    render(
      <SectionBox label="Sec" badge={null}>
        Child
      </SectionBox>,
    );
    expect(screen.queryByText('v2')).not.toBeInTheDocument();
  });

  it('renders headerRight content', () => {
    render(
      <SectionBox label="Sec" headerRight={<button>Toggle</button>}>
        Child
      </SectionBox>,
    );
    expect(screen.getByRole('button', { name: 'Toggle' })).toBeInTheDocument();
  });

  it('shows children by default when collapsible', () => {
    render(
      <SectionBox label="Sec" collapsible>
        Visible
      </SectionBox>,
    );
    expect(screen.getByText('Visible')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Toggle Sec/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('hides children when defaultCollapsed is true', () => {
    render(
      <SectionBox label="Sec" collapsible defaultCollapsed>
        Hidden
      </SectionBox>,
    );
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Toggle Sec/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('toggles children on header click', async () => {
    render(
      <SectionBox label="Sec" collapsible>
        Toggle me
      </SectionBox>,
    );
    expect(screen.getByText('Toggle me')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Toggle Sec/ }));
    expect(screen.queryByText('Toggle me')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Toggle Sec/ }));
    expect(screen.getByText('Toggle me')).toBeInTheDocument();
  });

  it('toggles on Enter and Space key', async () => {
    render(
      <SectionBox label="Sec" collapsible>
        Keyboard
      </SectionBox>,
    );
    const header = screen.getByRole('button', { name: /Toggle Sec/ });
    header.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByText('Keyboard')).not.toBeInTheDocument();
    await userEvent.keyboard(' ');
    expect(screen.getByText('Keyboard')).toBeInTheDocument();
  });

  it('does not collapse when headerRight is clicked', async () => {
    const fn = vi.fn();
    render(
      <SectionBox
        label="Sec"
        collapsible
        headerRight={<button onClick={fn}>Action</button>}
      >
        Content
      </SectionBox>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Action' }));
    expect(fn).toHaveBeenCalledOnce();
    expect(screen.getByText('Content')).toBeInTheDocument();
  });
});

describe('Chip', () => {
  it('renders label and handles click', async () => {
    const onClick = vi.fn();
    render(<Chip active={false} onClick={onClick} label="Option A" />);
    const chip = screen.getByRole('button', { name: 'Option A' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(chip);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows active state', () => {
    render(<Chip active={true} onClick={() => {}} label="Option B" />);
    const chip = screen.getByRole('button', { name: 'Option B' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip.className).toContain('border-chip-active-border');
  });

  it('shows inactive state', () => {
    render(<Chip active={false} onClick={() => {}} label="Option C" />);
    const chip = screen.getByRole('button', { name: 'Option C' });
    expect(chip.className).toContain('border-chip-border');
  });

  it('renders with type="button"', () => {
    render(<Chip active={false} onClick={() => {}} label="Test" />);
    expect(screen.getByRole('button', { name: 'Test' })).toHaveAttribute(
      'type',
      'button',
    );
  });
});

describe('ScrollHint', () => {
  it('renders children', () => {
    render(
      <ScrollHint>
        <div>Scrollable content</div>
      </ScrollHint>,
    );
    expect(screen.getByText('Scrollable content')).toBeInTheDocument();
  });

  it('does not show fade when content fits', () => {
    const { container } = render(
      <ScrollHint>
        <div>Short content</div>
      </ScrollHint>,
    );
    // In jsdom scrollWidth === clientWidth, so no fade
    const fade = container.querySelector('.pointer-events-none');
    expect(fade).not.toBeInTheDocument();
  });

  it('uses ResizeObserver to check overflow', () => {
    const observeFn = vi.fn();
    const disconnectFn = vi.fn();
    const OriginalRO = globalThis.ResizeObserver;

    class MockResizeObserver {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(el: Element) {
        observeFn(el);
        this.cb([], this as unknown as ResizeObserver);
      }
      unobserve = vi.fn();
      disconnect = disconnectFn;
    }
    globalThis.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver;

    const { container, unmount } = render(
      <ScrollHint>
        <div>Content</div>
      </ScrollHint>,
    );
    const scrollEl = container.querySelector('.overflow-x-auto')!;
    expect(observeFn).toHaveBeenCalledWith(scrollEl);

    unmount();
    expect(disconnectFn).toHaveBeenCalled();
    globalThis.ResizeObserver = OriginalRO;
  });

  it('shows fade when content overflows and hides on scroll to end', () => {
    const { container } = render(
      <ScrollHint>
        <div style={{ width: 2000 }}>Wide content</div>
      </ScrollHint>,
    );
    const scrollEl = container.querySelector('.overflow-x-auto')!;
    // Simulate overflow: scrollWidth > clientWidth
    Object.defineProperty(scrollEl, 'scrollWidth', {
      value: 2000,
      configurable: true,
    });
    Object.defineProperty(scrollEl, 'clientWidth', {
      value: 500,
      configurable: true,
    });
    Object.defineProperty(scrollEl, 'scrollLeft', {
      value: 0,
      configurable: true,
      writable: true,
    });
    fireEvent.scroll(scrollEl);
    expect(container.querySelector('.pointer-events-none')).toBeInTheDocument();

    // Simulate scrolled to end
    Object.defineProperty(scrollEl, 'scrollLeft', {
      value: 1500,
      configurable: true,
    });
    fireEvent.scroll(scrollEl);
    expect(
      container.querySelector('.pointer-events-none'),
    ).not.toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it('renders as span by default', () => {
    render(<StatusBadge label="LIVE" color="#4ade80" />);
    const badge = screen.getByText('LIVE');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveStyle({ color: '#4ade80' });
  });

  it('renders dot when dot prop is true', () => {
    render(<StatusBadge label="LIVE" color="#4ade80" dot />);
    expect(screen.getByText(/● LIVE/)).toBeInTheDocument();
  });

  it('does not render dot when dot is false', () => {
    render(<StatusBadge label="CLOSED" color="#808080" />);
    expect(screen.queryByText(/●/)).not.toBeInTheDocument();
  });

  it('renders as link when href is provided', () => {
    render(
      <StatusBadge
        label="Re-authenticate"
        color="#f87171"
        href="/api/auth/init"
      />,
    );
    const link = screen.getByRole('link', { name: 'Re-authenticate' });
    expect(link).toHaveAttribute('href', '/api/auth/init');
    expect(link.tagName).toBe('A');
  });

  it('passes title attribute', () => {
    render(
      <StatusBadge label="ERROR" color="#f87171" title="Something failed" />,
    );
    expect(screen.getByText('ERROR')).toHaveAttribute(
      'title',
      'Something failed',
    );
  });
});

describe('ErrorMsg', () => {
  it('renders children with alert role', () => {
    render(<ErrorMsg>Something went wrong</ErrorMsg>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
  });

  it('passes id attribute', () => {
    render(<ErrorMsg id="err-spot">Bad input</ErrorMsg>);
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'err-spot');
  });
});
