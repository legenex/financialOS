import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingRegion, OfflineState, Skeleton } from '@financialos/ui';
import { ApiError } from '../lib/api';

export function describeError(error: unknown): { title: string; description: string; code?: string } {
  if (error instanceof ApiError) {
    switch (error.kind) {
      case 'not_available':
        return {
          title: 'Not available yet',
          description: 'This server does not provide this data yet. Nothing is shown rather than a guess.',
          code: `${error.status} ${error.code}`,
        };
      case 'invalid_response':
        return { title: 'Unexpected response', description: error.message, code: error.code };
      case 'server':
        return { title: 'FinancialOS hit a problem', description: error.message, code: `${error.status} ${error.code}` };
      case 'session':
      case 'locked':
        return { title: 'Session ended', description: 'Sign in again to continue.', code: error.code };
      default:
        return { title: 'Could not load this', description: error.message, code: error.status ? `${error.status} ${error.code}` : error.code };
    }
  }
  return { title: 'Could not load this', description: error instanceof Error ? error.message : 'Unknown error' };
}

export function ApiErrorState({ error, onRetry, retrying, size = 'md' }: { error: unknown; onRetry?: () => void; retrying?: boolean; size?: 'sm' | 'md' }) {
  if (error instanceof ApiError && error.kind === 'network') return <OfflineState onRetry={onRetry} size={size} />;
  const d = describeError(error);
  const canRetry = !(error instanceof ApiError && (error.kind === 'not_available' || error.kind === 'session' || error.kind === 'locked'));
  return <ErrorState title={d.title} description={d.description} code={d.code} onRetry={canRetry ? onRetry : undefined} retrying={retrying} size={size} />;
}

export interface QueryStateProps<T> {
  query: UseQueryResult<T, unknown>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
  loadingLabel?: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  size?: 'sm' | 'md';
}

/** Loading → error (with retry) → empty → content, consistently. */
export function QueryState<T>({ query, children, loading, loadingLabel = 'Loading', isEmpty, empty, size = 'md' }: QueryStateProps<T>) {
  if (query.isPending) {
    return (
      <LoadingRegion label={loadingLabel}>
        {loading ?? (
          <>
            <Skeleton variant="figure" />
            <Skeleton lines={3} />
          </>
        )}
      </LoadingRegion>
    );
  }
  if (query.isError) {
    return <ApiErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} size={size} />;
  }
  const data = query.data as T;
  if (isEmpty?.(data)) return <>{empty ?? <EmptyState title="Nothing here yet" size={size} />}</>;
  return <>{children(data)}</>;
}
