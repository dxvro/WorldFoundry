import { useEffect, useId, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { formatMb } from '../lib/format';
import { MEMORY_UNITS, memoryText, parseMemory, unitFor, type MemoryUnit } from '../lib/memory';

interface MemoryRangeProps {
  label: string;
  // megabytes
  value: number;
  min: number;
  max: number;
  step: number;
  // `exact`: the value was typed and must not be snapped to the slider's steps
  onChange: (value: number, exact: boolean) => void;
  error?: string | undefined;
  disabled?: boolean;
}

// A memory slider with a field to type the amount in KB, MB or GB
export function MemoryRange({ label, value, min, max, step, onChange, error, disabled = false }: MemoryRangeProps): ReactNode {
  const { t } = useI18n();
  const m = t.common.memory;
  const id = useId();
  const [unit, setUnit] = useState<MemoryUnit>(() => unitFor(value));
  const [text, setText] = useState(() => memoryText(value, unit));
  const [editing, setEditing] = useState(false);
  const [typedError, setTypedError] = useState<string | undefined>(undefined);

  // the field follows the slider and outside changes while it is not being edited
  useEffect(() => {
    if (!editing) setText(memoryText(value, unit));
  }, [value, unit, editing]);

  const commit = (): void => {
    setEditing(false);
    const mb = parseMemory(text, unit);
    if (mb === null) {
      setTypedError(m.invalid);
      return;
    }
    if (mb < min || mb > max) {
      setTypedError(m.outOfRange(formatMb(min), formatMb(max)));
      return;
    }
    setTypedError(undefined);
    onChange(mb, true);
    setText(memoryText(mb, unit));
  };

  const shownError = typedError ?? error;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <label htmlFor={id} className="label">
          {label}
        </label>
        <span className="flex items-center gap-1">
          <input
            type="text"
            inputMode="decimal"
            aria-label={m.amount(label)}
            aria-invalid={shownError === undefined ? undefined : true}
            className="input num h-8 w-24 px-2 py-1 text-right"
            value={text}
            disabled={disabled}
            onFocus={() => setEditing(true)}
            onChange={(event) => {
              setText(event.target.value);
              setTypedError(undefined);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              // Enter takes the value instead of submitting the whole form
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
              if (event.key === 'Escape') {
                setEditing(false);
                setTypedError(undefined);
                setText(memoryText(value, unit));
              }
            }}
          />
          <select
            aria-label={m.unit(label)}
            className="input h-8 w-auto px-2 py-1"
            value={unit}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value as MemoryUnit;
              setUnit(next);
              setTypedError(undefined);
              setEditing(false);
              setText(memoryText(value, next));
            }}
          >
            {MEMORY_UNITS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={formatMb(value)}
        aria-invalid={shownError === undefined ? undefined : true}
        onChange={(event) => {
          setTypedError(undefined);
          onChange(Number(event.target.value), false);
        }}
        className="block h-8 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      />
      {shownError === undefined ? null : (
        <p role="alert" className="text-sm text-bad">
          {shownError}
        </p>
      )}
    </div>
  );
}
