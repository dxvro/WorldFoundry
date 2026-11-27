import { useEffect, useId, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { formatMb } from '../lib/format';
import { MEMORY_UNITS, memoryText, parseMemory, unitFor, type MemoryUnit } from '../lib/memory';
import { cx } from './ui';

// `exact`: the value was typed and must not be snapped to the slider's steps
export type MemoryChange = (value: number, exact: boolean) => void;

interface Limits {
  min: number;
  max: number;
  step: number;
}

// KB | MB | GB as one segmented control
function UnitSwitch({ unit, onChange, label, disabled }: { unit: MemoryUnit; onChange: (unit: MemoryUnit) => void; label: string; disabled: boolean }): ReactNode {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 gap-0.5 rounded-full border border-line-strong bg-canvas p-1">
      {MEMORY_UNITS.map((entry) => {
        const active = entry === unit;
        return (
          <button
            key={entry}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(entry)}
            className={cx(
              'min-h-8 min-w-11 rounded-full px-2.5 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-55',
              active ? 'bg-accent text-on-accent' : 'text-faint hover:bg-hover hover:text-ink',
            )}
          >
            {entry}
          </button>
        );
      })}
    </div>
  );
}

// The typed amount in the chosen unit; it takes the value on Enter or when the field is left
function MemoryField({
  label,
  hint,
  value,
  unit,
  limits,
  onChange,
  onError,
  invalid,
  disabled,
}: {
  label: string;
  hint: string;
  value: number;
  unit: MemoryUnit;
  limits: Limits;
  onChange: MemoryChange;
  onError: (message: string | undefined) => void;
  invalid: boolean;
  disabled: boolean;
}): ReactNode {
  const { t } = useI18n();
  const m = t.common.memory;
  const id = useId();
  const [text, setText] = useState(() => memoryText(value, unit));
  const [editing, setEditing] = useState(false);

  // the field follows the slider and outside changes while it is not being edited
  useEffect(() => {
    if (!editing) setText(memoryText(value, unit));
  }, [value, unit, editing]);

  const commit = (): void => {
    setEditing(false);
    const mb = parseMemory(text, unit);
    if (mb === null) {
      onError(m.invalid);
      return;
    }
    if (mb < limits.min || mb > limits.max) {
      onError(m.outOfRange(formatMb(limits.min), formatMb(limits.max)));
      return;
    }
    onError(undefined);
    onChange(mb, true);
    setText(memoryText(mb, unit));
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="label">
        {label} <span className="text-faint">{hint}</span>
      </label>
      <div
        className={cx(
          'flex h-12 items-center gap-1.5 rounded-xl border bg-canvas px-3.5 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-accent)_18%,transparent)]',
          invalid ? 'border-bad' : 'border-line-strong hover:border-accent-strong',
          disabled && 'opacity-55',
        )}
      >
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={invalid ? true : undefined}
          className="num w-full min-w-0 bg-transparent text-lg font-bold outline-none disabled:cursor-not-allowed"
          value={text}
          disabled={disabled}
          onFocus={() => setEditing(true)}
          onChange={(event) => {
            setText(event.target.value);
            onError(undefined);
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
              onError(undefined);
              setText(memoryText(value, unit));
            }
          }}
        />
        <span aria-hidden className="text-sm font-semibold text-faint">
          {unit}
        </span>
      </div>
    </div>
  );
}

const percentOf = (value: number, limits: Limits): number => (limits.max === limits.min ? 0 : ((value - limits.min) / (limits.max - limits.min)) * 100);

// Labels under the track: the ends and the whole gigabytes in between that fit
function Scale({ limits, warnAt }: { limits: Limits; warnAt: number | null }): ReactNode {
  const { t } = useI18n();
  const marks = [limits.min, limits.min + (limits.max - limits.min) / 2, limits.max].map((mb, index) => ({
    mb: index === 1 ? Math.round(mb / 1024) * 1024 : mb,
    index,
  }));
  return (
    <div aria-hidden className="num relative h-4 text-xs text-faint">
      {marks.map(({ mb, index }) => (
        <span
          key={index}
          className={cx('absolute whitespace-nowrap', index === 0 ? 'left-0' : index === 2 ? 'right-0' : '-translate-x-1/2')}
          style={index === 1 ? { left: `${percentOf(mb, limits)}%` } : undefined}
        >
          {formatMb(mb)}
        </span>
      ))}
      {warnAt === null ? null : (
        <span className="absolute -translate-x-1/2 font-bold text-warn" style={{ left: `${percentOf(warnAt, limits)}%` }}>
          {t.common.memory.tightMark}
        </span>
      )}
    </div>
  );
}

interface MemoryPairProps {
  minLabel: string;
  maxLabel: string;
  minRamMb: number;
  maxRamMb: number;
  limits: Limits;
  // the machine's memory, for the 75 % mark (null: unknown)
  totalMemoryMb: number | null;
  onMin: MemoryChange;
  onMax: MemoryChange;
  errors?: { minRamMb?: string | undefined; maxRamMb?: string | undefined };
  disabled?: boolean;
}

// Minimum and maximum memory: one track with two handles, a field on each side and one unit for both
export function MemoryPair({ minLabel, maxLabel, minRamMb, maxRamMb, limits, totalMemoryMb, onMin, onMax, errors = {}, disabled = false }: MemoryPairProps): ReactNode {
  const { t } = useI18n();
  const m = t.common.memory;
  const [unit, setUnit] = useState<MemoryUnit>(() => unitFor(maxRamMb));
  const [minTyped, setMinTyped] = useState<string | undefined>(undefined);
  const [maxTyped, setMaxTyped] = useState<string | undefined>(undefined);
  const low = percentOf(minRamMb, limits);
  const high = percentOf(maxRamMb, limits);
  const warnAt = totalMemoryMb === null ? null : Math.round(totalMemoryMb * 0.75);
  const showWarn = warnAt !== null && warnAt > limits.min && warnAt < limits.max;
  const messages = [minTyped ?? errors.minRamMb, maxTyped ?? errors.maxRamMb].filter((entry, index, all): entry is string => entry !== undefined && all.indexOf(entry) === index);
  // the lower handle comes to the front once it sits on the upper half, so both stay reachable
  const minOnTop = low > 50;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="chip chip-accent num">{m.range(formatMb(minRamMb), formatMb(maxRamMb))}</span>
        <UnitSwitch unit={unit} onChange={setUnit} label={m.unitBoth} disabled={disabled} />
      </div>
      <div className="grid grid-cols-2 items-end gap-x-4 gap-y-4 sm:grid-cols-[9.5rem_minmax(0,1fr)_9.5rem]">
        <MemoryField label={minLabel} hint="-Xms" value={minRamMb} unit={unit} limits={limits} onChange={onMin} onError={setMinTyped} invalid={(minTyped ?? errors.minRamMb) !== undefined} disabled={disabled} />
        <div className="order-3 col-span-2 space-y-2 pb-1 sm:order-none sm:col-span-1">
          <div className="dual-range relative h-7">
            <div aria-hidden className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line" />
            <div aria-hidden className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent" style={{ left: `${low}%`, width: `${Math.max(0, high - low)}%` }} />
            {showWarn ? <div aria-hidden className="absolute top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-warn" style={{ left: `${percentOf(warnAt, limits)}%` }} /> : null}
            <input
              type="range"
              aria-label={minLabel}
              aria-valuetext={formatMb(minRamMb)}
              min={limits.min}
              max={limits.max}
              step={limits.step}
              value={minRamMb}
              disabled={disabled}
              className={cx(minOnTop ? 'z-20' : 'z-10')}
              onChange={(event) => {
                setMinTyped(undefined);
                onMin(Number(event.target.value), false);
              }}
            />
            <input
              type="range"
              aria-label={maxLabel}
              aria-valuetext={formatMb(maxRamMb)}
              min={limits.min}
              max={limits.max}
              step={limits.step}
              value={maxRamMb}
              disabled={disabled}
              className={cx(minOnTop ? 'z-10' : 'z-20')}
              onChange={(event) => {
                setMaxTyped(undefined);
                onMax(Number(event.target.value), false);
              }}
            />
          </div>
          <Scale limits={limits} warnAt={showWarn ? warnAt : null} />
        </div>
        <MemoryField label={maxLabel} hint="-Xmx" value={maxRamMb} unit={unit} limits={limits} onChange={onMax} onError={setMaxTyped} invalid={(maxTyped ?? errors.maxRamMb) !== undefined} disabled={disabled} />
      </div>
      {messages.map((message) => (
        <p key={message} role="alert" className="text-sm text-bad">
          {message}
        </p>
      ))}
    </div>
  );
}

interface MemoryRangeProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: MemoryChange;
  error?: string | undefined;
  disabled?: boolean;
}

// One amount of memory (games with a single value): the same field, unit switch and track
export function MemoryRange({ label, value, min, max, step, onChange, error, disabled = false }: MemoryRangeProps): ReactNode {
  const { t } = useI18n();
  const m = t.common.memory;
  const [unit, setUnit] = useState<MemoryUnit>(() => unitFor(value));
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const limits = { min, max, step };
  const shown = typed ?? error;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[minmax(0,9.5rem)_auto] items-end justify-between gap-3">
        <MemoryField label={label} hint="" value={value} unit={unit} limits={limits} onChange={onChange} onError={setTyped} invalid={shown !== undefined} disabled={disabled} />
        <UnitSwitch unit={unit} onChange={setUnit} label={m.unit(label)} disabled={disabled} />
      </div>
      <div className="dual-range relative h-7">
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line" />
        <div aria-hidden className="absolute top-1/2 left-0 h-1.5 -translate-y-1/2 rounded-full bg-accent" style={{ width: `${percentOf(value, limits)}%` }} />
        <input
          type="range"
          aria-label={label}
          aria-valuetext={formatMb(value)}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          className="z-10"
          onChange={(event) => {
            setTyped(undefined);
            onChange(Number(event.target.value), false);
          }}
        />
      </div>
      <Scale limits={limits} warnAt={null} />
      {shown === undefined ? null : (
        <p role="alert" className="text-sm text-bad">
          {shown}
        </p>
      )}
    </div>
  );
}
