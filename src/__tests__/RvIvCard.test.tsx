import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RvIvCard from '../components/RvIvCard';
import { lightTheme } from '../themes';

const th = lightTheme;

describe('RvIvCard', () => {
  it('renders the ratio value', () => {
    render(
      <RvIvCard
        th={th}
        ratio={0.72}
        label="IV Rich"
        rvAnnualized={0.14}
        iv={0.19}
      />,
    );
    expect(screen.getByText('0.72x')).toBeInTheDocument();
  });

  it('renders IV Rich label and advice', () => {
    render(
      <RvIvCard
        th={th}
        ratio={0.72}
        label="IV Rich"
        rvAnnualized={0.14}
        iv={0.19}
      />,
    );
    expect(screen.getByText('IV Rich')).toBeInTheDocument();
    expect(
      screen.getByText(/premium selling is favorable/),
    ).toBeInTheDocument();
  });

  it('renders IV Cheap label and advice', () => {
    render(
      <RvIvCard
        th={th}
        ratio={1.35}
        label="IV Cheap"
        rvAnnualized={0.27}
        iv={0.2}
      />,
    );
    expect(screen.getByText('IV Cheap')).toBeInTheDocument();
    expect(
      screen.getByText(/Widen strikes or reduce size/),
    ).toBeInTheDocument();
  });

  it('renders Fair Value label and advice', () => {
    render(
      <RvIvCard
        th={th}
        ratio={0.95}
        label="Fair Value"
        rvAnnualized={0.19}
        iv={0.2}
      />,
    );
    expect(screen.getByText('Fair Value')).toBeInTheDocument();
    expect(screen.getByText(/roughly aligned/)).toBeInTheDocument();
  });

  it('displays RV and IV percentages', () => {
    render(
      <RvIvCard
        th={th}
        ratio={0.72}
        label="IV Rich"
        rvAnnualized={0.14}
        iv={0.19}
      />,
    );
    expect(screen.getByText('RV: 14.0%')).toBeInTheDocument();
    expect(screen.getByText('IV: 19.0%')).toBeInTheDocument();
  });

  it('renders the section title', () => {
    render(
      <RvIvCard
        th={th}
        ratio={1.0}
        label="Fair Value"
        rvAnnualized={0.2}
        iv={0.2}
      />,
    );
    expect(screen.getByText('RV / IV Ratio')).toBeInTheDocument();
  });
});
