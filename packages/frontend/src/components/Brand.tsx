import type { ReactNode } from 'react';
import { cx } from './ui';

// a world (ring with a meridian) resting on an anvil
export function BrandMark({ round = false, className }: { round?: boolean; className?: string }): ReactNode {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className={cx('size-7 shrink-0', className)}>
      <rect width="32" height="32" rx={round ? 16 : 10} fill="var(--color-accent)" />
      <circle cx="16" cy="12.5" r="6.5" fill="none" stroke="var(--color-on-accent)" strokeWidth="2" />
      <path d="M9.5 12.5h13M16 6c-3 3.5-3 9.500 0 13M16 6c3 3.5 3 9.500 0 13" fill="none" stroke="var(--color-on-accent)" strokeWidth="1.4" />
      <path d="M8 22h16l-2.500 4h-11z" fill="var(--color-on-accent)" />
    </svg>
  );
}
