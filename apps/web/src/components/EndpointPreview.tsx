import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Callout, EmptyState, PageHeader, Section } from '@financialos/ui';
import { api } from '../lib/api';
import { QueryState } from './QueryState';

export interface EndpointPreviewProps {
  title: string;
  description: string;
  endpoint: string;
  /** Human name of the list, e.g. "accounts". */
  noun: string;
  children?: ReactNode;
}

function countOf(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object' && 'items' in data && Array.isArray((data as { items: unknown }).items)) {
    return (data as { items: unknown[] }).items.length;
  }
  return null;
}

/**
 * Placeholder body for destinations that the next UI agent builds out. It performs a real request against the
 * area's primary endpoint and shows honest loading, error and empty states — never sample data.
 */
export function EndpointPreview({ title, description, endpoint, noun, children }: EndpointPreviewProps) {
  const query = useQuery({
    queryKey: ['preview', endpoint],
    queryFn: ({ signal }) => api<unknown>(endpoint, { signal }),
  });
  return (
    <>
      <PageHeader title={title} description={description} />
      {children}
      <Section title={`Loading data from ${endpoint}`} description="This area is being built. The request below is live." level={2}>
        <QueryState
          query={query}
          loadingLabel={`Loading ${noun}`}
          isEmpty={(data) => countOf(data) === 0}
          empty={<EmptyState title={`No ${noun} yet`} description={`When ${noun} exist, they will appear here.`} />}
        >
          {(data) => {
            const count = countOf(data);
            return (
              <Callout tone="neutral" title={count === null ? 'Connected' : `${count} ${noun} available`}>
                The full {title} experience is coming in the next build. Data is loaded but not displayed yet.
              </Callout>
            );
          }}
        </QueryState>
      </Section>
    </>
  );
}
