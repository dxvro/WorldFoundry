import { useId, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { formatClock } from '../lib/format';
import { cx } from './ui';

export interface SparkPoint {
  at: number;
  value: number | null;
}

interface SparklineProps {
  points: readonly SparkPoint[];
  // the top of the scale: 100 for percent, the total for memory; the scale never shrinks below the data
  max: number;
  // what the line shows, for screen readers
  label: string;
  format: (value: number) => string;
  // a level drawn as a dashed line (85 % of the scale: "high")
  warnAt?: number;
  className?: string;
}

const W = 240;
const H = 64;
const PAD = 3;

// One series over time: a 2px line over a faint area, a recessive baseline, and on hover a crosshair with the value
// and the time. Gaps (no reading) break the line instead of drawing to zero.
export function Sparkline({ points, max, label, format, warnAt, className }: SparklineProps): ReactNode {
  const gradient = useId();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((point) => point.value).filter((value): value is number => value !== null);
  const top = Math.max(max, ...values, 1);
  const n = points.length;
  const x = (index: number): number => (n <= 1 ? W - PAD : PAD + (index / (n - 1)) * (W - 2 * PAD));
  const y = (value: number): number => H - PAD - (value / top) * (H - 2 * PAD);

  // separate runs where readings are missing
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push([x(index), y(point.value)]);
  });
  if (run.length > 0) runs.push(run);
  const line = runs.map((part) => part.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join('')).join('');
  const area = runs
    .filter((part) => part.length > 1)
    .map((part) => `M${part[0]?.[0].toFixed(1)},${H - PAD}${part.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('')}L${part.at(-1)?.[0].toFixed(1)},${H - PAD}Z`)
    .join('');

  const pick = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = box.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || n === 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (n - 1)));
  };
  const hovered = hover === null ? undefined : points[hover];
  const last = [...points].reverse().find((point) => point.value !== null);

  return (
    <div
      ref={box}
      className={cx('relative h-16 w-full touch-none', className)}
      onPointerMove={pick}
      onPointerDown={pick}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="size-full overflow-visible" role="img" aria-label={last?.value === null || last === undefined ? label : `${label}: ${format(last.value)}`}>
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={0} x2={W} y1={H - PAD} y2={H - PAD} stroke="var(--color-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {warnAt === undefined || warnAt >= top ? null : (
          <line x1={0} x2={W} y1={y(warnAt)} y2={y(warnAt)} stroke="var(--color-warn)" strokeOpacity="0.55" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        )}
        {area === '' ? null : <path d={area} fill={`url(#${gradient})`} />}
        {line === '' ? null : <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {hover === null ? null : <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--color-faint)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      {hovered === undefined || hover === null ? null : (
        <>
          {hovered.value === null ? null : (
            <span
              aria-hidden
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-accent"
              style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(hovered.value) / H) * 100}%` }}
            />
          )}
          <span
            role="status"
            className={cx(
              'num pointer-events-none absolute -top-9 z-10 whitespace-nowrap rounded-md border border-line-strong bg-raised px-2 py-1 text-xs shadow-lg',
              hover > n / 2 ? '-translate-x-full' : '',
            )}
            style={{ left: `${(x(hover) / W) * 100}%` }}
          >
            <strong className="font-semibold text-ink">{hovered.value === null ? '–' : format(hovered.value)}</strong>
            <span className="ml-1.5 text-faint">{formatClock(hovered.at)}</span>
          </span>
        </>
      )}
    </div>
  );
}
