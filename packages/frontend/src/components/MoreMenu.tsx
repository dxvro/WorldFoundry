import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from './ui';

export interface MoreMenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

// height of one entry and the padding of the list, to decide whether the list fits below the button
const ITEM_PX = 38;
const FRAME_PX = 18;

// A "…" button with a short list of rarely used actions. Closes on a choice, Escape, a click outside or when the
// page moves. The list is placed against the window, so a scrolling table around the button cannot cut it off.
export function MoreMenu({ label, items }: { label: string; items: MoreMenuItem[]; size?: 'sm' | 'md' }): ReactNode {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
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
    const onMove = (): void => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  const toggle = (): void => {
    if (!open && button.current !== null) {
      const rect = button.current.getBoundingClientRect();
      const right = Math.max(8, window.innerWidth - rect.right);
      const fitsBelow = rect.bottom + 4 + items.length * ITEM_PX + FRAME_PX <= window.innerHeight;
      setPlace(fitsBelow || rect.top < window.innerHeight / 2 ? { top: rect.bottom + 4, right } : { bottom: window.innerHeight - rect.top + 4, right });
    }
    setOpen(!open);
  };

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
        onClick={toggle}
        className="grid size-9 cursor-pointer place-items-center rounded-xl border-0 bg-transparent text-dim hover:bg-hover hover:text-ink aria-expanded:bg-hover aria-expanded:text-ink"
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label={label} style={place} className="fixed z-40 flex min-w-44 flex-col rounded-xl border border-line bg-raised p-2 shadow-lg">
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
              className={cx(
                'inline-flex w-full cursor-pointer items-center gap-2 rounded-xl border-0 bg-transparent p-2 text-left text-sm font-medium hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50',
                item.danger ? 'text-bad' : 'text-dim hover:text-ink',
              )}
            >
              {item.icon === undefined ? null : <item.icon aria-hidden className="size-4 shrink-0" />}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
