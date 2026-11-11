import { MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from './ui';

export interface MoreMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

// A "…" button with a short list of rarely used actions. Closes on a choice, Escape or a click outside.
export function MoreMenu({ label, items, size = 'md' }: { label: string; items: MoreMenuItem[]; size?: 'sm' | 'md' }): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cx('btn', size === 'sm' ? 'btn-sm' : null, 'px-2.5')}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label={label} className="panel absolute right-0 z-30 mt-1 min-w-44 p-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cx('flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-raised disabled:opacity-50', item.danger ? 'text-bad' : 'text-ink')}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
