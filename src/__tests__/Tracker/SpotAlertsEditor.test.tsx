import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpotAlertsEditor } from '../../components/Tracker/SpotAlertsEditor';
import type { SpotAlert } from '../../components/Tracker/types';

describe('SpotAlertsEditor', () => {
  it('shows "None set" hint when spotAlerts is null', () => {
    render(
      <SpotAlertsEditor
        ticker="SPY"
        spotAlerts={null}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText('None set')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove SPY/ })).toBeNull();
  });

  it('renders one chip per existing alert with the ticker, op, and level', () => {
    const alerts: SpotAlert[] = [
      { op: '>=', level: 595 },
      { op: '<', level: 580 },
    ];
    render(
      <SpotAlertsEditor
        ticker="SPY"
        spotAlerts={alerts}
        onChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Remove SPY >= 595 alert' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove SPY < 580 alert' }),
    ).toBeInTheDocument();
  });

  it('exposes all four operators in the dropdown', () => {
    render(
      <SpotAlertsEditor
        ticker="SPY"
        spotAlerts={null}
        onChange={() => undefined}
      />,
    );
    const select = screen.getByRole('combobox', {
      name: 'Spot alert comparison operator',
    });
    const options = Array.from(select.querySelectorAll('option')).map(
      (o) => o.value,
    );
    expect(options).toEqual(['>=', '<=', '>', '<']);
  });

  it('add fires onChange with appended alert + clears the level input', () => {
    const onChange = vi.fn();
    render(
      <SpotAlertsEditor
        ticker="SPY"
        spotAlerts={[{ op: '>=', level: 595 }]}
        onChange={onChange}
      />,
    );
    const level = screen.getByRole('textbox', { name: 'Spot alert level' });
    fireEvent.change(level, { target: { value: '600' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add spot alert' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([
      { op: '>=', level: 595 },
      { op: '>=', level: 600 },
    ]);
    // Input cleared after add
    expect(level).toHaveValue('');
  });

  it('silently rejects non-numeric level input on submit', () => {
    const onChange = vi.fn();
    render(
      <SpotAlertsEditor
        ticker="SPY"
        spotAlerts={null}
        onChange={onChange}
      />,
    );
    const level = screen.getByRole('textbox', { name: 'Spot alert level' });
    fireEvent.change(level, { target: { value: 'not-a-number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add spot alert' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('click on chip removes that index — fires onChange with filtered list', () => {
    const onChange = vi.fn();
    const alerts: SpotAlert[] = [
      { op: '>=', level: 595 },
      { op: '<', level: 580 },
    ];
    render(
      <SpotAlertsEditor
        ticker="SPY"
        spotAlerts={alerts}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove SPY >= 595 alert' }),
    );
    expect(onChange).toHaveBeenCalledWith([{ op: '<', level: 580 }]);
  });

  it('removing the LAST chip fires onChange(null), not onChange([])', () => {
    const onChange = vi.fn();
    render(
      <SpotAlertsEditor
        ticker="SPY"
        spotAlerts={[{ op: '>=', level: 595 }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove SPY >= 595 alert' }),
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
