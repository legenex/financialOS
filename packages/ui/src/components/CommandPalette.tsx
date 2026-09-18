import type { ReactNode } from 'react';
import { Command } from 'cmdk';
import { Dialog as RDialog } from 'radix-ui';
import { Search } from 'lucide-react';
import { Spinner } from './Spinner';

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  /** Extra words that should match this item. */
  keywords?: string[];
  shortcut?: string;
  onSelect: () => void;
}

export interface CommandGroup {
  id: string;
  heading: string;
  items: CommandItem[];
  /** Server results are already filtered; skip client-side matching for them. */
  forceMount?: boolean;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: CommandGroup[];
  search: string;
  onSearchChange: (value: string) => void;
  loading?: boolean;
  /** Message shown under the list, e.g. search errors. */
  status?: ReactNode;
  placeholder?: string;
  label?: string;
}

/** Compact command palette (cmdk in a modal dialog). Focus is trapped and restored on close. */
export function CommandPalette({ open, onOpenChange, groups, search, onSearchChange, loading, status, placeholder = 'Search or jump to…', label = 'Command palette' }: CommandPaletteProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fos-overlay" />
        <RDialog.Content className="fos-palette" aria-describedby={undefined}>
          <RDialog.Title className="fos-sr-only">{label}</RDialog.Title>
          <Command label={label} className="fos-command" loop>
          <div className="fos-command__search">
            <Search size={18} aria-hidden="true" className="fos-command__search-icon" />
            <Command.Input className="fos-command__input fos-command__input--lg" value={search} onValueChange={onSearchChange} placeholder={placeholder} />
            {loading && <Spinner size={16} label="Searching" />}
            <kbd className="fos-kbd fos-command__esc">Esc</kbd>
          </div>
          <Command.List className="fos-command__list fos-command__list--lg">
            <Command.Empty className="fos-command__empty">{loading ? 'Searching…' : 'No results'}</Command.Empty>
            {groups
              .filter((g) => g.items.length > 0)
              .map((group) => (
                <Command.Group key={group.id} heading={group.heading} className="fos-command__group" forceMount={group.forceMount}>
                  {group.items.map((item) => (
                    <Command.Item
                      key={item.id}
                      value={`${group.id}:${item.id} ${item.label}`}
                      keywords={item.keywords}
                      forceMount={group.forceMount}
                      onSelect={() => {
                        onOpenChange(false);
                        item.onSelect();
                      }}
                      className="fos-command__item"
                    >
                      {item.icon && (
                        <span className="fos-command__icon" aria-hidden="true">
                          {item.icon}
                        </span>
                      )}
                      <span className="fos-command__label">
                        {item.label}
                        {item.hint && <span className="fos-command__desc">{item.hint}</span>}
                      </span>
                      {item.shortcut && <kbd className="fos-kbd">{item.shortcut}</kbd>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
          </Command.List>
          {status && <div className="fos-command__status">{status}</div>}
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="fos-kbd">{children}</kbd>;
}
