import { forwardRef, useId, useState, type ReactNode } from 'react';
import { Checkbox as RCheckbox, Popover as RPopover, RadioGroup as RRadio, Select as RSelect, Switch as RSwitch } from 'radix-ui';
import { Command } from 'cmdk';
import { Check, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cx } from '../lib/cx';
import { describedBy, FieldShell } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: ReactNode;
  value: string | null;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  hideLabel?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  size?: 'sm' | 'md';
}

/** Styled single select (radix). For long or searchable lists use Combobox. */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  { label, value, onValueChange, options, placeholder = 'Choose…', hint, error, required, optional, hideLabel, disabled, id: idProp, className, size = 'md' },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? `s${autoId}`;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} optional={optional} hideLabel={hideLabel} className={className}>
      <RSelect.Root value={value ?? undefined} onValueChange={onValueChange} disabled={disabled} required={required}>
        <RSelect.Trigger
          ref={ref}
          id={id}
          className={cx('fos-select', `fos-select--${size}`)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
        >
          <RSelect.Value placeholder={placeholder} />
          <RSelect.Icon className="fos-select__icon">
            <ChevronDown size={16} aria-hidden="true" />
          </RSelect.Icon>
        </RSelect.Trigger>
        <RSelect.Portal>
          <RSelect.Content className="fos-menu" position="popper" sideOffset={6} collisionPadding={12}>
            <RSelect.Viewport className="fos-menu__viewport">
              {options.map((o) => (
                <RSelect.Item key={o.value} value={o.value} disabled={o.disabled} className="fos-menu__item">
                  <RSelect.ItemText>{o.label}</RSelect.ItemText>
                  {o.description && <span className="fos-menu__desc">{o.description}</span>}
                  <RSelect.ItemIndicator className="fos-menu__check">
                    <Check size={16} aria-hidden="true" />
                  </RSelect.ItemIndicator>
                </RSelect.Item>
              ))}
            </RSelect.Viewport>
          </RSelect.Content>
        </RSelect.Portal>
      </RSelect.Root>
    </FieldShell>
  );
});

export interface ComboboxProps {
  label: ReactNode;
  value: string | null;
  onValueChange: (value: string | null) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  hideLabel?: boolean;
  disabled?: boolean;
  /** Show a "None" option that clears the value. */
  clearable?: boolean;
  clearLabel?: string;
  id?: string;
  className?: string;
}

/** Searchable select: a button that opens a filterable listbox (cmdk) in a popover. */
export function Combobox({
  label,
  value,
  onValueChange,
  options,
  placeholder = 'Choose…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  hint,
  error,
  required,
  optional,
  hideLabel,
  disabled,
  clearable,
  clearLabel = 'None',
  id: idProp,
  className,
}: ComboboxProps) {
  const autoId = useId();
  const id = idProp ?? `c${autoId}`;
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value) ?? null;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required} optional={optional} hideLabel={hideLabel} className={className}>
      <RPopover.Root open={open} onOpenChange={setOpen}>
        <RPopover.Trigger asChild>
          <button
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(id, hint, error)}
            disabled={disabled}
            className="fos-select fos-select--md"
          >
            <span className={cx(!selected && 'fos-select__placeholder')}>{selected ? selected.label : placeholder}</span>
            <ChevronsUpDown size={16} aria-hidden="true" className="fos-select__icon" />
          </button>
        </RPopover.Trigger>
        <RPopover.Portal>
          <RPopover.Content className="fos-menu fos-combobox" sideOffset={6} align="start" collisionPadding={12}>
            <Command label={typeof label === 'string' ? label : 'Options'} className="fos-command fos-command--inline">
              <Command.Input className="fos-command__input" placeholder={searchPlaceholder} />
              <Command.List className="fos-command__list">
                <Command.Empty className="fos-command__empty">{emptyText}</Command.Empty>
                {clearable && (
                  <Command.Item
                    value={`__none__ ${clearLabel}`}
                    className="fos-command__item"
                    onSelect={() => {
                      onValueChange(null);
                      setOpen(false);
                    }}
                  >
                    <span className="fos-command__label">{clearLabel}</span>
                    {value === null && <Check size={16} aria-hidden="true" />}
                  </Command.Item>
                )}
                {options.map((o) => (
                  <Command.Item
                    key={o.value}
                    value={`${o.label} ${o.value}`}
                    disabled={o.disabled}
                    className="fos-command__item"
                    onSelect={() => {
                      onValueChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <span className="fos-command__label">
                      {o.label}
                      {o.description && <span className="fos-command__desc">{o.description}</span>}
                    </span>
                    {o.value === value && <Check size={16} aria-hidden="true" />}
                  </Command.Item>
                ))}
              </Command.List>
            </Command>
          </RPopover.Content>
        </RPopover.Portal>
      </RPopover.Root>
    </FieldShell>
  );
}

export interface SwitchProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Switch({ label, description, checked, onCheckedChange, disabled, id: idProp, className }: SwitchProps) {
  const autoId = useId();
  const id = idProp ?? `sw${autoId}`;
  return (
    <div className={cx('fos-toggle-row', className)}>
      <div className="fos-toggle-row__text">
        <label htmlFor={id} className="fos-toggle-row__label">
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="fos-toggle-row__desc">
            {description}
          </p>
        )}
      </div>
      <RSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="fos-switch"
        aria-describedby={description ? `${id}-desc` : undefined}
      >
        <RSwitch.Thumb className="fos-switch__thumb" />
      </RSwitch.Root>
    </div>
  );
}

export interface CheckboxProps {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Checkbox({ label, description, checked, onCheckedChange, disabled, id: idProp, className }: CheckboxProps) {
  const autoId = useId();
  const id = idProp ?? `cb${autoId}`;
  return (
    <div className={cx('fos-check-row', className)}>
      <RCheckbox.Root
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        disabled={disabled}
        className="fos-checkbox"
        aria-describedby={description ? `${id}-desc` : undefined}
      >
        <RCheckbox.Indicator className="fos-checkbox__indicator">
          <Check size={14} strokeWidth={3} aria-hidden="true" />
        </RCheckbox.Indicator>
      </RCheckbox.Root>
      <div className="fos-check-row__text">
        <label htmlFor={id} className="fos-check-row__label">
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="fos-check-row__desc">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  label: ReactNode;
  value: string | null;
  onValueChange: (value: string) => void;
  options: RadioOption[];
  hint?: ReactNode;
  error?: ReactNode;
  variant?: 'list' | 'cards';
  className?: string;
  required?: boolean;
}

export function RadioGroup({ label, value, onValueChange, options, hint, error, variant = 'list', className, required }: RadioGroupProps) {
  const autoId = useId();
  const id = `rg${autoId}`;
  return (
    <fieldset className={cx('fos-fieldset', error ? 'fos-field--invalid' : undefined, className)} aria-describedby={describedBy(id, hint, error)}>
      <legend className="fos-field__label">
        {label}
        {required && <span className="fos-field__req" aria-hidden="true"> *</span>}
      </legend>
      <RRadio.Root value={value ?? undefined} onValueChange={onValueChange} className={cx('fos-radio-group', `fos-radio-group--${variant}`)} required={required}>
        {options.map((o) => {
          const optionId = `${id}-${o.value}`;
          return (
            <div key={o.value} className="fos-radio-option">
              <RRadio.Item id={optionId} value={o.value} disabled={o.disabled} className="fos-radio" aria-describedby={o.description ? `${optionId}-desc` : undefined}>
                <RRadio.Indicator className="fos-radio__dot" />
              </RRadio.Item>
              <div className="fos-radio-option__text">
                <label htmlFor={optionId} className="fos-radio-option__label">
                  {o.label}
                </label>
                {o.description && (
                  <p id={`${optionId}-desc`} className="fos-radio-option__desc">
                    {o.description}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </RRadio.Root>
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
    </fieldset>
  );
}
