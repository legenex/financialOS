import type { SourceLink } from '@financialos/contracts';

/**
 * Where each kind of source record lives in the app. Money/Business/Settings routes are implemented by the
 * feature agent; keep these paths stable (documented in apps/web/HANDOFF.md).
 */
export function sourceHref(link: Pick<SourceLink, 'kind' | 'id'>): string {
  const id = encodeURIComponent(link.id);
  switch (link.kind) {
    case 'account':
      return `/money/accounts/${id}`;
    case 'transaction':
      return `/money/transactions/${id}`;
    case 'snapshot':
      return `/money/snapshots/${id}`;
    case 'holding':
      return `/money/investments?holding=${id}`;
    case 'recurring':
      return `/plan/commitments?recurring=${id}`;
    case 'obligation':
      return `/plan/commitments?obligation=${id}`;
    case 'goal':
      return `/plan/goals?goal=${id}`;
    case 'document':
      return `/money/documents/${id}`;
    case 'exception':
      return `/inbox?item=${id}`;
    case 'setting':
      return `/settings/${id}`;
    case 'arrangement':
      return `/business/clearing/${id}`;
    case 'restriction':
      return `/money/investments/restricted?restriction=${id}`;
    case 'receivable':
      return `/business/receivables?item=${id}`;
    case 'scenario':
      return `/business/scenarios/${id}`;
    default:
      return '/today';
  }
}

/** Only in-app paths are followed from API-provided hrefs. */
export function internalHref(href: string | null | undefined, fallback = '/today'): string {
  if (!href || !href.startsWith('/') || href.startsWith('//')) return fallback;
  return href;
}
