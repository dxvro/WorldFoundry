import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRange } from './MemoryRange';

function Harness({ onChange }: { onChange: (value: number, exact: boolean) => void }): ReactNode {
  const [value, setValue] = useState(10240);
  return (
    <form onSubmit={() => onChange(-1, false)}>
      <MemoryRange
        label="Maximum memory"
        value={value}
        min={256}
        max={16384}
        step={128}
        onChange={(next, exact) => {
          onChange(next, exact);
          setValue(next);
        }}
      />
    </form>
  );
}

describe('memory field', () => {
  it('takes a typed amount in GB, MB or KB without snapping it', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const amount = screen.getByLabelText('Maximum memory: amount');
    const unit = screen.getByLabelText('Maximum memory: unit');
    expect(amount).toHaveValue('10');
    expect(unit).toHaveValue('GB');

    await user.clear(amount);
    await user.type(amount, '6,5{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(6656, true);

    await user.selectOptions(unit, 'MB');
    expect(amount).toHaveValue('6656');
    await user.clear(amount);
    await user.type(amount, '3000');
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(3000, true);

    await user.selectOptions(unit, 'KB');
    expect(amount).toHaveValue('3072000');
    // Enter never submitted the form
    expect(onChange).not.toHaveBeenCalledWith(-1, false);
  });

  it('refuses values outside the limits and text that is no number', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const amount = screen.getByLabelText('Maximum memory: amount');
    await user.clear(amount);
    await user.type(amount, '20{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('between 256 MB and 16 GB');
    await user.clear(amount);
    await user.type(amount, 'viel{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a number');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('follows the slider', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Maximum memory' }), { target: { value: '4096' } });
    expect(onChange).toHaveBeenLastCalledWith(4096, false);
    expect(screen.getByLabelText('Maximum memory: amount')).toHaveValue('4');
  });
});
