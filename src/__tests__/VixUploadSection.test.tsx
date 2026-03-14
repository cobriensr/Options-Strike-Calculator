import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import VixUploadSection from '../components/VixUploadSection';
import { lightTheme } from '../themes';

const th = lightTheme;

describe('VixUploadSection', () => {
  function renderSection(
    overrides: Partial<{
      vixDataLoaded: boolean;
      vixDataSource: string;
      onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
    }> = {},
  ) {
    const ref = createRef<HTMLInputElement>();
    const onFileUpload = overrides.onFileUpload ?? vi.fn();
    return render(
      <VixUploadSection
        th={th}
        vixDataLoaded={overrides.vixDataLoaded ?? false}
        vixDataSource={overrides.vixDataSource ?? ''}
        fileInputRef={ref}
        onFileUpload={onFileUpload}
      />,
    );
  }

  it('renders section heading', () => {
    renderSection();
    expect(screen.getByText('Historical VIX Data')).toBeInTheDocument();
  });

  it('shows upload button when no data loaded', () => {
    renderSection();
    expect(screen.getByText('Upload VIX OHLC CSV')).toBeInTheDocument();
  });

  it('shows replace button when data is loaded', () => {
    renderSection({ vixDataLoaded: true, vixDataSource: 'uploaded.csv' });
    expect(screen.getByText('Replace CSV')).toBeInTheDocument();
  });

  it('renders file input with csv accept', () => {
    renderSection();
    const input = screen.getByLabelText('Upload VIX OHLC CSV file');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('accept', '.csv');
  });

  it('calls onFileUpload when file is selected', () => {
    const onFileUpload = vi.fn();
    renderSection({ onFileUpload });
    const input = screen.getByLabelText('Upload VIX OHLC CSV file');
    const file = new File(['date,open,high,low,close'], 'vix.csv', {
      type: 'text/csv',
    });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFileUpload).toHaveBeenCalledOnce();
  });

  it('shows CSV format hint', () => {
    renderSection();
    expect(
      screen.getByText(/CSV with Date, Open, High, Low, Close/),
    ).toBeInTheDocument();
  });
});
