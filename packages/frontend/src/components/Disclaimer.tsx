import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cx } from './ui';

export function Disclaimer({ className }: { className?: string }): ReactNode {
  const { t } = useI18n();
  return <p className={cx('text-xs leading-snug text-faint', className)}>{t.common.disclaimer}</p>;
}
