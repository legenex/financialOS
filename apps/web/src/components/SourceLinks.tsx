import type { SourceLink } from '@financialos/contracts';
import { Link } from '@financialos/ui';
import { sourceHref } from '../lib/links';

export function SourceLinks({ links, label = 'Sources', max = 6 }: { links: SourceLink[]; label?: string; max?: number }) {
  if (!links.length) return null;
  const shown = links.slice(0, max);
  return (
    <p className="fos-sources">
      <span className="text-ink-3">{label}:</span>
      {shown.map((l) => (
        <Link key={`${l.kind}-${l.id}`} href={sourceHref(l)} variant="subtle">
          {l.label}
        </Link>
      ))}
      {links.length > max && <span className="text-ink-3">+{links.length - max} more</span>}
    </p>
  );
}
