import type { ReactNode } from 'react';
import type { Explanation, ExplanationItem } from '@financialos/contracts';
import { Callout, Drawer, Money, StatusBadge } from '@financialos/ui';
import { formatDate } from '../lib/format';
import { SourceLinks } from './SourceLinks';

const GROUPS: Array<{ role: ExplanationItem['role']; title: string }> = [
  { role: 'input', title: 'Inputs' },
  { role: 'added', title: 'Added' },
  { role: 'subtracted', title: 'Subtracted' },
  { role: 'excluded', title: 'Excluded' },
  { role: 'assumption', title: 'Assumptions' },
  { role: 'missing', title: 'Missing' },
  { role: 'result', title: 'Result' },
];

export interface ExplanationDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  explanation: Explanation;
  status?: string;
  computedAt?: string | null;
  children?: ReactNode;
}

function ItemRow({ item }: { item: ExplanationItem }) {
  return (
    <li className="fos-explain-item">
      <div className="fos-explain-item__row">
        <span className="fos-explain-item__label">{item.label}</span>
        {item.value ? (
          <Money value={item.value} weight="medium" signed={item.role === 'added'} />
        ) : item.role === 'missing' || item.role === 'assumption' ? null : (
          <Money value={null} unknownReason="No amount is recorded for this line." />
        )}
      </div>
      {item.note && <p className="fos-explain-item__note">{item.note}</p>}
      {item.fx && (
        <p className="fos-explain-item__note">
          Converted {item.fx.from} → {item.fx.to} at {item.fx.rate} ({item.fx.rateSource}, {formatDate(item.fx.rateAsOf)}, {item.fx.method.replace(/_/g, ' ')})
        </p>
      )}
      <SourceLinks links={item.links} />
    </li>
  );
}

/**
 * "How this is calculated": formula, inputs, what was subtracted or excluded, assumptions, what is missing,
 * and links back to the records that produced the number.
 */
export function ExplanationDrawer({ open, onOpenChange, title, explanation, status, computedAt, children }: ExplanationDrawerProps) {
  const extraAssumptions = explanation.assumptions;
  const extraMissing = explanation.missing;
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={title} description={explanation.summary} width="lg">
      <div className="flex flex-col gap-5">
        {(status || computedAt) && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
            {status && <StatusBadge status={status} />}
            {computedAt && <span>Calculated {new Date(computedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>}
          </div>
        )}
        {children}
        <section aria-labelledby="explain-formula">
          <h3 id="explain-formula" className="fos-explain-group__title">
            Formula
          </h3>
          <p className="fos-explain-formula">{explanation.formula}</p>
        </section>
        {GROUPS.map(({ role, title: groupTitle }) => {
          const items = explanation.items.filter((i) => i.role === role);
          const strings = role === 'assumption' ? extraAssumptions : role === 'missing' ? extraMissing : [];
          if (!items.length && !strings.length) return null;
          return (
            <section key={role} className="fos-explain-group" aria-label={groupTitle}>
              <h3 className="fos-explain-group__title">{groupTitle}</h3>
              {role === 'missing' && (
                <Callout tone="warning" className="mb-2">
                  Missing information makes this result provisional. Nothing missing is treated as zero.
                </Callout>
              )}
              <ul className="m-0 list-none p-0">
                {items.map((item, i) => (
                  <ItemRow key={`${role}-${i}`} item={item} />
                ))}
                {strings.map((text, i) => (
                  <li key={`${role}-s-${i}`} className="fos-explain-item">
                    <span className="text-ink-2">{text}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Drawer>
  );
}
