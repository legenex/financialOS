import type { ReactNode } from 'react';
import { Tabs as RTabs, ToggleGroup } from 'radix-ui';
import { cx } from '../lib/cx';

export interface TabItem {
  value: string;
  label: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  items: TabItem[];
  children: ReactNode;
  label: string;
  className?: string;
}

/** Tabs with a horizontally scrollable list (never overflows the page). Use TabPanel for each item. */
export function Tabs({ value, onValueChange, items, children, label, className }: TabsProps) {
  return (
    <RTabs.Root value={value} onValueChange={onValueChange} className={cx('fos-tabs', className)}>
      <div className="fos-tabs__scroller">
        <RTabs.List className="fos-tabs__list" aria-label={label}>
          {items.map((item) => (
            <RTabs.Trigger key={item.value} value={item.value} disabled={item.disabled} className="fos-tabs__trigger">
              <span>{item.label}</span>
              {item.badge !== undefined && item.badge !== null && <span className="fos-tabs__badge fos-num">{item.badge}</span>}
            </RTabs.Trigger>
          ))}
        </RTabs.List>
      </div>
      {children}
    </RTabs.Root>
  );
}

export function TabPanel({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <RTabs.Content value={value} className={cx('fos-tabs__panel', className)}>
      {children}
    </RTabs.Content>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  label: string;
  size?: 'sm' | 'md';
  className?: string;
  fullWidth?: boolean;
}

/** A compact single-choice switcher (radio semantics). Arrow keys move between options. */
export function SegmentedControl<T extends string>({ value, onValueChange, options, label, size = 'md', className, fullWidth }: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      aria-label={label}
      className={cx('fos-segmented', `fos-segmented--${size}`, fullWidth && 'fos-segmented--full', className)}
    >
      {options.map((option) => (
        <ToggleGroup.Item key={option.value} value={option.value} disabled={option.disabled} className="fos-segmented__item">
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
