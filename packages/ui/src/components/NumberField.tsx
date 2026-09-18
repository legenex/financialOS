import { forwardRef, useEffect, useId, useState, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { describedBy, FieldShell } from './Field';

export interface NumberFieldProps {
  label: ReactNode;
  /** Decimal string ("1234.50") or null when empty. Never a JS number. */
  value: string | null;
  /** Receives a normalised decimal string, or null when the input is empty. Not called while the input is invalid. */
  onValueChange: (value: string | null) => void;
  /** Maximum decimal places (e.g. the currency's minor units). Extra digits are an error, never rounded silently. */
  scale?: number;
  allowNegative?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  hideLabel?: boolean;
  /** Currency code or unit shown before the value. */
  prefix?: ReactNode;
  suffix?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  onValidityChange?: (valid: boolean) => void;
  autoFocus?: boolean;
}

const GROUPING = /[\s,'’_]/g;

/** Parses user text into a canonical decimal string. Returns undefined when invalid, null when empty. */
export function parseDecimalInput(text: string, { scale, allowNegative = false }: { scale?: number; allowNegative?: boolean } = {}):
  | { ok: true; value: string | null }
  | { ok: false; reason: string } {
  const trimmed = text.trim().replace(/^−/, '-');
  if (trimmed === '') return { ok: true, value: null };
  const compact = trimmed.replace(GROUPING, '');
  if (!/^-?\d*(\.\d*)?$/.test(compact) || compact === '-' || compact === '.' || compact === '-.') {
    return { ok: false, reason: 'Enter a number such as 1250.00' };
  }
  if (compact.startsWith('-') && !allowNegative) return { ok: false, reason: 'Enter a positive amount' };
  const negative = compact.startsWith('-');
  const [rawInt = '', fracPart = ''] = compact.replace('-', '').split('.');
  if (scale !== undefined && fracPart.length > scale) {
    return { ok: false, reason: scale === 0 ? 'Use whole numbers only' : `Use at most ${scale} decimal place${scale === 1 ? '' : 's'}` };
  }
  const intPart = rawInt.replace(/^0+(?=\d)/, '') || '0';
  if (intPart.length > 20) return { ok: false, reason: 'That number is too large' };
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  const isZero = /^0(\.0*)?$/.test(body);
  return { ok: true, value: negative && !isZero ? `-${body}` : body };
}

/**
 * Decimal input with a text keyboard (inputMode="decimal"). Accepts grouping separators ("1,250.00"),
 * emits canonical decimal strings, and reports invalid input instead of guessing.
 */
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  { label, value, onValueChange, scale, allowNegative, hint, error, required, optional, hideLabel, prefix, suffix, placeholder, disabled, id: idProp, name, className, onValidityChange, autoFocus },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? `n${autoId}`;
  const [text, setText] = useState(value ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  // Adopt external value changes that differ from what the text currently represents.
  useEffect(() => {
    const parsed = parseDecimalInput(text, { scale, allowNegative });
    const current = parsed.ok ? parsed.value : undefined;
    if (current !== value) {
      setText(value ?? '');
      setLocalError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to external value changes
  }, [value]);

  const shownError = error ?? localError;
  return (
    <FieldShell id={id} label={label} hint={hint} error={shownError} required={required} optional={optional} hideLabel={hideLabel} className={className}>
      <div className={cx('fos-input', prefix ? 'fos-input--leading' : undefined, suffix ? 'fos-input--trailing' : undefined)}>
        {prefix && <span className="fos-input__adorn fos-input__adorn--leading">{prefix}</span>}
        <input
          ref={ref}
          id={id}
          name={name}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          className="fos-input__control fos-num fos-input__control--numeric"
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={describedBy(id, hint, shownError)}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            const parsed = parseDecimalInput(next, { scale, allowNegative });
            if (parsed.ok) {
              setLocalError(null);
              onValidityChange?.(true);
              onValueChange(parsed.value);
            } else {
              onValidityChange?.(false);
            }
          }}
          onBlur={() => {
            const parsed = parseDecimalInput(text, { scale, allowNegative });
            if (!parsed.ok) {
              setLocalError(parsed.reason);
            } else {
              setLocalError(null);
              setText(parsed.value ?? '');
            }
          }}
        />
        {suffix && <span className="fos-input__adorn fos-input__adorn--trailing">{suffix}</span>}
      </div>
    </FieldShell>
  );
});
