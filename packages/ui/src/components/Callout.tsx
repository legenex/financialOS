import type { ReactNode } from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { cx } from '../lib/cx';

export type CalloutTone = 'info' | 'warning' | 'critical' | 'success' | 'neutral';

const ICONS: Record<CalloutTone, ReactNode> = {
  info: <Info size={18} />,
  warning: <AlertTriangle size={18} />,
  critical: <AlertOctagon size={18} />,
  success: <CheckCircle2 size={18} />,
  neutral: <Info size={18} />,
};

export interface CalloutProps {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Use role="alert" for urgent, just-appeared messages. */
  live?: boolean;
}

export function Callout({ tone = 'info', title, children, icon, actions, className, live }: CalloutProps) {
  return (
    <div className={cx('fos-callout', `fos-callout--${tone}`, className)} role={live ? (tone === 'critical' ? 'alert' : 'status') : undefined}>
      <span className="fos-callout__icon" aria-hidden="true">
        {icon ?? ICONS[tone]}
      </span>
      <div className="fos-callout__content">
        {title && <p className="fos-callout__title">{title}</p>}
        {children && <div className="fos-callout__body">{children}</div>}
        {actions && <div className="fos-callout__actions">{actions}</div>}
      </div>
    </div>
  );
}
