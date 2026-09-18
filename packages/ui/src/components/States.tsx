import type { ReactNode } from 'react';
import { AlertOctagon, CloudOff, Inbox, RotateCw, WifiOff } from 'lucide-react';
import { cx } from '../lib/cx';
import { Button } from './Button';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}

/** Nothing to show yet. Always explain why and offer the next step. */
export function EmptyState({ title, description, icon, actions, size = 'md', className }: EmptyStateProps) {
  return (
    <div className={cx('fos-state', `fos-state--${size}`, className)}>
      <div className="fos-state__icon" aria-hidden="true">
        {icon ?? <Inbox size={22} />}
      </div>
      <p className="fos-state__title">{title}</p>
      {description && <p className="fos-state__description">{description}</p>}
      {actions && <div className="fos-state__actions">{actions}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Machine code shown in small print to help support (never secrets). */
  code?: string;
  onRetry?: () => void;
  retrying?: boolean;
  actions?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}

/** Something failed. Announced politely; offers retry when the caller supports it. */
export function ErrorState({ title = 'Something went wrong', description, code, onRetry, retrying, actions, size = 'md', className }: ErrorStateProps) {
  return (
    <div className={cx('fos-state', 'fos-state--error', `fos-state--${size}`, className)} role="alert">
      <div className="fos-state__icon" aria-hidden="true">
        <AlertOctagon size={22} />
      </div>
      <p className="fos-state__title">{title}</p>
      {description && <p className="fos-state__description">{description}</p>}
      {(onRetry || actions) && (
        <div className="fos-state__actions">
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry} loading={retrying} leadingIcon={<RotateCw size={16} />}>
              Try again
            </Button>
          )}
          {actions}
        </div>
      )}
      {code && <p className="fos-state__code fos-num">Reference: {code}</p>}
    </div>
  );
}

export interface OfflineStateProps {
  onRetry?: () => void;
  className?: string;
  size?: 'sm' | 'md';
}

/** Shown when the network is unavailable. FinancialOS never shows cached financial data offline. */
export function OfflineState({ onRetry, className, size = 'md' }: OfflineStateProps) {
  return (
    <div className={cx('fos-state', `fos-state--${size}`, className)} role="status">
      <div className="fos-state__icon" aria-hidden="true">
        <WifiOff size={22} />
      </div>
      <p className="fos-state__title">Offline — FinancialOS needs a connection</p>
      <p className="fos-state__description">
        Financial data is never stored on this device, so nothing can be shown until the connection returns.
      </p>
      {onRetry && (
        <div className="fos-state__actions">
          <Button variant="secondary" size="sm" onClick={onRetry} leadingIcon={<CloudOff size={16} />}>
            Check again
          </Button>
        </div>
      )}
    </div>
  );
}

export interface SkeletonProps {
  variant?: 'line' | 'block' | 'circle' | 'figure';
  width?: string;
  height?: string;
  className?: string;
  lines?: number;
}

/** Loading placeholder. Decorative: wrap regions in aria-busy containers with a text label instead. */
export function Skeleton({ variant = 'line', width, height, className, lines = 1 }: SkeletonProps) {
  if (variant === 'line' && lines > 1) {
    return (
      <span className={cx('fos-skeleton-group', className)} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="fos-skeleton fos-skeleton--line" style={{ width: i === lines - 1 ? '60%' : width }} />
        ))}
      </span>
    );
  }
  return <span className={cx('fos-skeleton', `fos-skeleton--${variant}`, className)} style={{ width, height }} aria-hidden="true" />;
}

/** A labelled loading region: skeleton visuals with a single announcement for assistive technology. */
export function LoadingRegion({ label = 'Loading', children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('fos-loading', className)} aria-busy="true">
      <span className="fos-sr-only" role="status">
        {label}
      </span>
      {children}
    </div>
  );
}
