import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryPair } from './MemoryRange';

function Harness({ onChange }: { onChange: (which: 'min' | 'max', value: number, exact: boolean) => void }): ReactNode {
  const [pair, setPair] = useState({ min: 1024, max: 10240 });
  return (
    <form onSubmit={() => onChange('min', -1, false)}>
      <MemoryPair
        minLabel="Minimum memory"
        maxLabel="Maximum memory"
        minRamMb={pair.min}
        maxRamMb={pair.max}
        limits={{ min: 256, max: 16384, step: 128 }}
        totalMemoryMb={16384}
        onMin={(value, exact) => {
          onChange('min', value, exact);
          setPair((current) => ({ ...current, min: value }));
        }}
        onMax={(value, exact) => {
          onChange('max', value, exact);
          setPair((current) => ({ ...current, max: value }));
        }}
      />
    </form>
  );
}

const units = (): HTMLElement => screen.getByRole('group', { name: 'Unit of the memory fields' });

describe('memory pair', () => {
  it('takes typed amounts in GB, MB or KB for both fields without snapping them', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const max = screen.getByRole('textbox', { name: /Maximum memory/ });
    const min = screen.getByRole('textbox', { name: /Minimum memory/ });
    expect(max).toHaveValue('10');
    expect(min).toHaveValue('1');
    expect(within(units()).getByRole('button', { name: 'GB' })).toHaveAttribute('aria-pressed', 'true');

    await user.clear(max);
    await user.type(max, '6,5{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('max', 6656, true);

    // one unit for both fields
    await user.click(within(units()).getByRole('button', { name: 'MB' }));
    expect(max).toHaveValue('6656');
    expect(min).toHaveValue('1024');
    await user.clear(min);
    await user.type(min, '3000');
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith('min', 3000, true);

    await user.click(within(units()).getByRole('button', { name: 'KB' }));
    expect(min).toHaveValue('3072000');
    expect(screen.getByText('2.9 GB to 6.5 GB')).toBeInTheDocument();
    // Enter never submitted the form
    expect(onChange).not.toHaveBeenCalledWith('min', -1, false);
  });

  it('refuses values outside the limits and text that is no number', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const max = screen.getByRole('textbox', { name: /Maximum memory/ });
    await user.clear(max);
    await user.type(max, '20{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('between 256 MB and 16 GB');
    expect(max).toHaveAttribute('aria-invalid', 'true');
    await user.clear(max);
    await user.type(max, 'viel{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a number');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves each handle of the track on its own, and the fields follow', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Maximum memory' }), { target: { value: '4096' } });
    expect(onChange).toHaveBeenLastCalledWith('max', 4096, false);
    expect(screen.getByRole('textbox', { name: /Maximum memory/ })).toHaveValue('4');
    fireEvent.change(screen.getByRole('slider', { name: 'Minimum memory' }), { target: { value: '2048' } });
    expect(onChange).toHaveBeenLastCalledWith('min', 2048, false);
    expect(screen.getByRole('textbox', { name: /Minimum memory/ })).toHaveValue('2');
  });
});
