import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImageIssues from '../../components/ChartAnalysis/ImageIssues';

const singleIssue = [
  {
    imageIndex: 0,
    label: 'Blurry chart',
    issue: 'Image is low resolution',
    suggestion: 'Upload a higher resolution screenshot',
  },
];

const multipleIssues = [
  {
    imageIndex: 0,
    label: 'Blurry chart',
    issue: 'Image is low resolution',
    suggestion: 'Upload a higher resolution screenshot',
  },
  {
    imageIndex: 1,
    label: 'Wrong timeframe',
    issue: 'Chart shows daily instead of intraday',
    suggestion: 'Use a 5-minute chart',
  },
];

describe('ImageIssues', () => {
  it('renders singular text for a single issue', () => {
    render(<ImageIssues imageIssues={singleIssue} onReplaceImage={vi.fn()} />);
    // "1 image needs improvement" (singular: no 's' on image, 's' on needs)
    expect(screen.getByText(/1 image needs improvement/i)).toBeInTheDocument();
  });

  it('renders plural text for multiple issues', () => {
    render(
      <ImageIssues imageIssues={multipleIssues} onReplaceImage={vi.fn()} />,
    );
    // "2 images need improvement" (plural: 's' on images, no 's' on need)
    expect(screen.getByText(/2 images need improvement/i)).toBeInTheDocument();
  });

  it('renders each issue label and details', () => {
    render(
      <ImageIssues imageIssues={multipleIssues} onReplaceImage={vi.fn()} />,
    );
    expect(screen.getByText(/Blurry chart/)).toBeInTheDocument();
    expect(screen.getByText(/Wrong timeframe/)).toBeInTheDocument();
    expect(screen.getByText(/Image is low resolution/)).toBeInTheDocument();
    expect(
      screen.getByText(/Chart shows daily instead of intraday/),
    ).toBeInTheDocument();
  });

  it('renders suggestion text', () => {
    render(<ImageIssues imageIssues={singleIssue} onReplaceImage={vi.fn()} />);
    expect(
      screen.getByText(/Upload a higher resolution screenshot/),
    ).toBeInTheDocument();
  });

  it('calls onReplaceImage with correct index when Replace is clicked', async () => {
    const user = userEvent.setup();
    const onReplace = vi.fn();
    render(
      <ImageIssues imageIssues={multipleIssues} onReplaceImage={onReplace} />,
    );
    const buttons = screen.getAllByRole('button', { name: 'Replace' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]!);
    expect(onReplace).toHaveBeenCalledWith(0);
    await user.click(buttons[1]!);
    expect(onReplace).toHaveBeenCalledWith(1);
  });

  it('renders footer with plural form when multiple issues', () => {
    render(
      <ImageIssues imageIssues={multipleIssues} onReplaceImage={vi.fn()} />,
    );
    // "Replace the flagged images, then click Analyze again."
    expect(screen.getByText(/Replace the flagged images/)).toBeInTheDocument();
  });

  it('renders footer with singular form when single issue', () => {
    render(<ImageIssues imageIssues={singleIssue} onReplaceImage={vi.fn()} />);
    // "Replace the flagged image, then click Analyze again."
    expect(screen.getByText(/Replace the flagged image,/)).toBeInTheDocument();
  });
});
