import type { ReactNode } from 'react';

// The slowly turning network of points and lines behind every page; decoration only.
export function Backdrop(): ReactNode {
  return (
    <div aria-hidden className="backdrop">
      <svg viewBox="0 0 400 400" fill="none">
        <g stroke="currentColor" strokeWidth="0.6" opacity="0.55">
          <path d="M200 60 290 110 330 200 290 290 200 340 110 290 70 200 110 110Z" />
          <path d="M200 60 200 340M70 200 330 200M110 110 290 290M290 110 110 290" />
          <path d="M200 60 150 150 70 200 150 250 200 340 250 250 330 200 250 150Z" />
          <path d="M150 150 250 150 250 250 150 250Z" />
          <path d="M110 110 150 150M290 110 250 150M290 290 250 250M110 290 150 250" />
          <path d="M200 200 150 150M200 200 250 150M200 200 250 250M200 200 150 250" />
          <path d="M40 120 110 110M360 90 290 110M370 300 290 290M30 290 110 290M200 20 200 60M200 380 200 340" />
        </g>
        <g fill="var(--color-dim)">
          {POINTS.map(([x, y, r]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} />
          ))}
        </g>
        <circle cx="200" cy="200" r="3.2" fill="var(--color-accent)" />
      </svg>
    </div>
  );
}

const POINTS: ReadonlyArray<readonly [number, number, number]> = [
  [200, 60, 2.4],
  [290, 110, 2],
  [330, 200, 2.4],
  [290, 290, 2],
  [200, 340, 2.4],
  [110, 290, 2],
  [70, 200, 2.4],
  [110, 110, 2],
  [150, 150, 1.8],
  [250, 150, 1.8],
  [250, 250, 1.8],
  [150, 250, 1.8],
  [40, 120, 1.4],
  [360, 90, 1.4],
  [370, 300, 1.4],
  [30, 290, 1.4],
  [200, 20, 1.4],
  [200, 380, 1.4],
];
