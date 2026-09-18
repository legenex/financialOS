import type { SourceLink } from '@financialos/contracts';

/**
 * Resolves a SourceLink to a route inside FinancialOS, when the destination page can show that record
 * directly. Kinds without a dedicated detail view resolve to null so callers show plain text instead of a
 * link that goes nowhere useful.
 */
export function sourceLinkHref(link: Pick<SourceLink, 'kind' | 'id'>): string | null {
  switch (link.kind) {
    case 'account':
      return `/money/accounts?open=${encodeURIComponent(link.id)}`;
    case 'transaction':
      return `/money/transactions?open=${encodeURIComponent(link.id)}`;
    case 'goal':
      return `/plan/goals`;
    case 'recurring':
      return `/plan/subscriptions`;
    case 'obligation':
      return `/plan/commitments`;
    case 'exception':
      return `/inbox`;
    case 'restriction':
      return `/money/restricted`;
    case 'receivable':
      return `/business/receivables`;
    case 'arrangement':
      return `/business/clearing`;
    case 'setting':
      return `/settings`;
    case 'scenario':
      return `/plan/simulator`;
    case 'document':
    case 'snapshot':
    case 'holding':
    default:
      return null;
  }
}
