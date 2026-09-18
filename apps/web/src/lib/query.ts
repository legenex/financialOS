import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * TanStack Query setup. Nothing is persisted; cached data lives in memory for a short time and is cleared on
 * lock. Window-focus refetching is off because the session layer re-checks the session on focus instead.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 2 * 60_000,
        staleTime: 20_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            if (error.code === 'aborted' || error.code === 'session_locked') return false;
            if (error.status >= 400 && error.status < 500) return false;
          }
          return failureCount < 1;
        },
      },
      mutations: { retry: false, gcTime: 30_000 },
    },
  });
}
