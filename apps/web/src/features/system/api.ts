import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DomainMigrationPlan, JobRecord, SystemStatus, type DomainMigrationInput } from '@financialos/contracts';
import { api, listOf, type ApiError } from '../../lib/api';

export function useSystemStatus() {
  return useQuery({
    queryKey: ['system'],
    queryFn: ({ signal }) => api('/api/system', { schema: SystemStatus, background: true, signal }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useJobs(status: string | null = null) {
  return useQuery({
    queryKey: ['jobs', status],
    queryFn: ({ signal }) => api('/api/jobs', { schema: listOf(JobRecord), query: status ? { status } : undefined, background: true, signal }),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation<JobRecord, ApiError, string>({
    mutationFn: (id) => api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {}, schema: JobRecord }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

export function usePlanDomainMigration() {
  return useMutation<DomainMigrationPlan, ApiError, DomainMigrationInput>({
    mutationFn: (input) => api('/api/system/domain-migration/plan', { method: 'POST', body: input, schema: DomainMigrationPlan }),
  });
}
