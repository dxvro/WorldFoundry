import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Button } from './ui';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

// The native <dialog> provides the focus trap, Escape handling and the inert backdrop.
export function Dialog({ open, title, onClose, children, footer }: DialogProps): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useI18n();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] max-w-none rounded-xl border border-line-strong bg-panel p-0 shadow-2xl shadow-black/60"
    >
      {open ? (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-line p-4">
            <h2 id={titleId} className="text-base">
              {title}
            </h2>
            <Button variant="ghost" size="sm" iconOnly icon={X} onClick={onClose}>
              {t.common.close}
            </Button>
          </div>
          <div className="space-y-4 overflow-y-auto p-4">{children}</div>
          {footer === undefined ? null : <div className="flex flex-wrap justify-end gap-2 border-t border-line p-4">{footer}</div>}
        </div>
      ) : null}
    </dialog>
  );
}
