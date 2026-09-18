import type { ReactNode } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  CirclePause,
  CircleSlash,
  Clock,
  FileUp,
  Info,
  KeyRound,
  Link2Off,
  Loader,
  PlugZap,
  RefreshCw,
} from 'lucide-react';
import { cx } from '../lib/cx';

export type Tone = 'neutral' | 'accent' | 'positive' | 'caution' | 'negative' | 'info';

interface BadgeSpec {
  label: string;
  tone: Tone;
  icon: ReactNode;
}

const ICON = 14;

/** Status vocabulary shared by results, connections, severities and jobs. Always rendered with icon + label. */
export const STATUS_SPECS = {
  // ResultStatus
  ok: { label: 'Complete', tone: 'positive', icon: <CheckCircle2 size={ICON} /> },
  provisional: { label: 'Provisional', tone: 'caution', icon: <CircleDashed size={ICON} /> },
  insufficient_data: { label: 'Insufficient data', tone: 'neutral', icon: <CircleHelp size={ICON} /> },
  // ConnectionStatus
  not_configured: { label: 'Not configured', tone: 'neutral', icon: <PlugZap size={ICON} /> },
  needs_authorization: { label: 'Needs authorisation', tone: 'caution', icon: <KeyRound size={ICON} /> },
  connected: { label: 'Connected', tone: 'positive', icon: <CheckCircle2 size={ICON} /> },
  syncing: { label: 'Syncing', tone: 'info', icon: <RefreshCw size={ICON} /> },
  partial_coverage: { label: 'Partial coverage', tone: 'caution', icon: <CircleDashed size={ICON} /> },
  import_only: { label: 'Import only', tone: 'neutral', icon: <FileUp size={ICON} /> },
  stale: { label: 'Stale', tone: 'caution', icon: <Clock size={ICON} /> },
  rate_limited: { label: 'Rate limited', tone: 'caution', icon: <CirclePause size={ICON} /> },
  error: { label: 'Error', tone: 'negative', icon: <AlertOctagon size={ICON} /> },
  paused: { label: 'Paused', tone: 'neutral', icon: <CirclePause size={ICON} /> },
  revoked: { label: 'Revoked', tone: 'negative', icon: <Link2Off size={ICON} /> },
  // Severity
  info: { label: 'Info', tone: 'info', icon: <Info size={ICON} /> },
  warning: { label: 'Warning', tone: 'caution', icon: <AlertTriangle size={ICON} /> },
  critical: { label: 'Critical', tone: 'negative', icon: <AlertOctagon size={ICON} /> },
  // Jobs / generic
  queued: { label: 'Queued', tone: 'neutral', icon: <Clock size={ICON} /> },
  running: { label: 'Running', tone: 'info', icon: <Loader size={ICON} /> },
  succeeded: { label: 'Succeeded', tone: 'positive', icon: <CheckCircle2 size={ICON} /> },
  failed: { label: 'Failed', tone: 'negative', icon: <AlertOctagon size={ICON} /> },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: <CircleSlash size={ICON} /> },
  open: { label: 'Open', tone: 'caution', icon: <CircleDashed size={ICON} /> },
  resolved: { label: 'Resolved', tone: 'positive', icon: <CheckCircle2 size={ICON} /> },
  dismissed: { label: 'Dismissed', tone: 'neutral', icon: <CircleSlash size={ICON} /> },
  snoozed: { label: 'Snoozed', tone: 'neutral', icon: <Clock size={ICON} /> },
} satisfies Record<string, BadgeSpec>;

export type StatusKind = keyof typeof STATUS_SPECS;

export interface StatusBadgeProps {
  status: StatusKind | string;
  /** Override the default label. */
  label?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusBadge({ status, label, tone, icon, size = 'md', className }: StatusBadgeProps) {
  const spec: BadgeSpec | undefined = (STATUS_SPECS as Record<string, BadgeSpec>)[status];
  const resolvedTone = tone ?? spec?.tone ?? 'neutral';
  const resolvedLabel = label ?? spec?.label ?? humanize(status);
  return (
    <span className={cx('fos-badge', `fos-badge--${resolvedTone}`, `fos-badge--${size}`, className)}>
      <span className="fos-badge__icon" aria-hidden="true">
        {icon ?? spec?.icon ?? <Info size={ICON} />}
      </span>
      <span>{resolvedLabel}</span>
    </span>
  );
}

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md';
  className?: string;
}

/** A plain pill for counts and labels that are not statuses. */
export function Badge({ children, tone = 'neutral', size = 'sm', className }: BadgeProps) {
  return <span className={cx('fos-badge', 'fos-badge--plain', `fos-badge--${tone}`, `fos-badge--${size}`, className)}>{children}</span>;
}

export function humanize(value: string): string {
  const text = value.replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
