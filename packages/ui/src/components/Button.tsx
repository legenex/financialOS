import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Slot } from 'radix-ui';
import { cx } from '../lib/cx';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button, and sets aria-busy. */
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  /** Render the child element (e.g. a router link) with button styling. */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, leadingIcon, trailingIcon, fullWidth, asChild, className, children, disabled, type, ...rest },
  ref,
) {
  const classes = cx('fos-btn', `fos-btn--${variant}`, `fos-btn--${size}`, fullWidth && 'fos-btn--full', className);
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={16} label="" /> : leadingIcon ? <span className="fos-btn__icon" aria-hidden="true">{leadingIcon}</span> : null}
      {children !== undefined && <span className="fos-btn__label">{children}</span>}
      {trailingIcon && !loading ? <span className="fos-btn__icon" aria-hidden="true">{trailingIcon}</span> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name. Also shown as a tooltip unless `tooltip` is false. */
  label: string;
  icon: ReactNode;
  variant?: Exclude<ButtonVariant, 'primary'> | 'primary';
  size?: ButtonSize;
  tooltip?: boolean;
  /** Small count badge (e.g. unread items). */
  badge?: number;
  loading?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', tooltip = true, badge, loading, className, type, disabled, ...rest },
  ref,
) {
  const accessibleName = badge ? `${label} (${badge})` : label;
  const button = (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={accessibleName}
      className={cx('fos-btn', 'fos-iconbtn', `fos-btn--${variant}`, `fos-iconbtn--${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={16} label="" /> : <span className="fos-btn__icon" aria-hidden="true">{icon}</span>}
      {badge ? (
        <span className="fos-iconbtn__badge fos-num" aria-hidden="true">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </button>
  );
  if (!tooltip) return button;
  return <Tooltip content={label}>{button}</Tooltip>;
});
