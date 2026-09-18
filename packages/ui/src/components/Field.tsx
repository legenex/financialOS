import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cx } from '../lib/cx';

export interface FieldShellProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  hideLabel?: boolean;
  children: ReactNode;
  className?: string;
  /** Extra element rendered to the right of the label (e.g. a "Show" toggle). */
  labelAside?: ReactNode;
}

/** Label + control + hint + error, with ids wired for aria-describedby. */
export function FieldShell({ id, label, hint, error, required, optional, hideLabel, children, className, labelAside }: FieldShellProps) {
  return (
    <div className={cx('fos-field', error ? 'fos-field--invalid' : undefined, className)}>
      <div className={cx('fos-field__labelrow', hideLabel && 'fos-sr-only')}>
        <label htmlFor={id} className="fos-field__label">
          {label}
          {required && (
            <span className="fos-field__req" aria-hidden="true">
              {' '}
              *
            </span>
          )}
          {optional && <span className="fos-field__opt"> (optional)</span>}
        </label>
        {labelAside}
      </div>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="fos-field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="fos-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function describedBy(id: string, hint?: ReactNode, error?: ReactNode): string | undefined {
  const ids = [error ? `${id}-error` : null, hint && !error ? `${id}-hint` : null].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  hideLabel?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  labelAside?: ReactNode;
  fieldClassName?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, optional, hideLabel, leading, trailing, labelAside, id: idProp, className, fieldClassName, required, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? `f${autoId}`;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} optional={optional} hideLabel={hideLabel} className={fieldClassName} labelAside={labelAside}>
      <div className={cx('fos-input', leading ? 'fos-input--leading' : undefined, trailing ? 'fos-input--trailing' : undefined)}>
        {leading && <span className="fos-input__adorn fos-input__adorn--leading">{leading}</span>}
        <input
          ref={ref}
          id={id}
          className={cx('fos-input__control', className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          required={required}
          {...rest}
        />
        {trailing && <span className="fos-input__adorn fos-input__adorn--trailing">{trailing}</span>}
      </div>
    </FieldShell>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  hideLabel?: boolean;
  fieldClassName?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, optional, hideLabel, id: idProp, className, fieldClassName, required, rows = 3, ...rest },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? `f${autoId}`;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} optional={optional} hideLabel={hideLabel} className={fieldClassName}>
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        className={cx('fos-textarea', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        required={required}
        {...rest}
      />
    </FieldShell>
  );
});

export interface DateFieldProps extends Omit<TextFieldProps, 'type' | 'value' | 'onChange'> {
  /** ISO calendar date YYYY-MM-DD, or '' for none. */
  value: string;
  onChange: (value: string) => void;
}

/** Native date input (best mobile keyboard and accessibility); value is an ISO date string. */
export const DateField = forwardRef<HTMLInputElement, DateFieldProps>(function DateField({ value, onChange, ...rest }, ref) {
  return <TextField ref={ref} type="date" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
});
