import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ArrangementPolicyInput,
  CashForecast,
  ClearingAccountSummary,
  ConsolidatedView,
  Entity,
  EntityCashSummary,
  ReceivablePayable,
  ReceivablePayableInput,
  SupportTracker,
} from '@financialos/contracts';
import { api, listOf, type ApiError } from '../../lib/api';

const ClearingPolicyResult = z.object({ jobId: z.string(), arrangement: ClearingAccountSummary });

const businessKeys = {
  entities: (entityId: string | null) => ['business', 'entities', entityId] as const,
  consolidated: (entityIds: string[]) => ['business', 'consolidated', entityIds] as const,
  forecast: (params: { entityId: string | null; scenarioId: string | null }) => ['business', 'forecast', params] as const,
  receivables: (entityId: string | null, kind: 'receivable' | 'payable' | null) => ['business', 'receivables', entityId, kind] as const,
  clearing: ['business', 'clearing'] as const,
  support: ['business', 'support'] as const,
};

export function useBusinessEntities(entityId: string | null = null) {
  return useQuery({
    queryKey: businessKeys.entities(entityId),
    queryFn: ({ signal }) => api('/api/business/entities', { schema: listOf(EntityCashSummary), query: entityId ? { entityId } : undefined, signal }).then((r) => r),
  });
}

export function useConsolidatedView(entityIds: string[] = []) {
  return useQuery({
    queryKey: businessKeys.consolidated(entityIds),
    queryFn: ({ signal }) => api('/api/business/consolidated', { schema: ConsolidatedView, query: entityIds.length > 0 ? { entityIds: entityIds.join(',') } : undefined, signal }),
  });
}

export function useCashForecast(params: { entityId?: string | null; scenarioId?: string | null; weeks?: number } = {}) {
  return useQuery({
    queryKey: businessKeys.forecast({ entityId: params.entityId ?? null, scenarioId: params.scenarioId ?? null }),
    queryFn: ({ signal }) =>
      api('/api/business/forecast', {
        schema: CashForecast,
        query: { ...(params.entityId ? { entityId: params.entityId } : {}), ...(params.scenarioId ? { scenarioId: params.scenarioId } : {}), ...(params.weeks ? { weeks: params.weeks } : {}) },
        signal,
      }),
  });
}

export function useReceivablesPayables(entityId: string | null = null, kind: 'receivable' | 'payable' | null = null) {
  return useQuery({
    queryKey: businessKeys.receivables(entityId, kind),
    queryFn: ({ signal }) =>
      api('/api/business/receivables-payables', { schema: listOf(ReceivablePayable), query: { ...(entityId ? { entityId } : {}), ...(kind ? { kind } : {}) }, signal }),
  });
}

export function useCreateReceivable() {
  const qc = useQueryClient();
  return useMutation<ReceivablePayable, ApiError, ReceivablePayableInput>({
    mutationFn: (input) => api('/api/business/receivables-payables', { method: 'POST', body: input, schema: ReceivablePayable }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['business', 'receivables'] }),
  });
}

export function useUpdateReceivable() {
  const qc = useQueryClient();
  return useMutation<ReceivablePayable, ApiError, { id: string } & Partial<ReceivablePayableInput>>({
    mutationFn: (input) => api('/api/business/receivables-payables', { method: 'PUT', body: input, schema: ReceivablePayable }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['business', 'receivables'] }),
  });
}

export function useClearingSummaries() {
  return useQuery({
    queryKey: businessKeys.clearing,
    queryFn: ({ signal }) => api('/api/business/clearing', { schema: listOf(ClearingAccountSummary), signal }),
  });
}

export function useSetClearingPolicy() {
  const qc = useQueryClient();
  return useMutation<{ jobId: string; arrangement: ClearingAccountSummary }, ApiError, { arrangementId: string; input: ArrangementPolicyInput }>({
    mutationFn: ({ arrangementId, input }) =>
      api(`/api/business/clearing/${encodeURIComponent(arrangementId)}/policy`, { method: 'PUT', body: input, schema: ClearingPolicyResult }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: businessKeys.clearing }),
  });
}

export function useSupportTracker() {
  return useQuery({
    queryKey: businessKeys.support,
    queryFn: ({ signal }) => api('/api/business/support', { schema: SupportTracker, signal }),
  });
}

export function useCreateEntity() {
  const qc = useQueryClient();
  return useMutation<Entity, ApiError, { name: string; kind: Entity['kind']; jurisdiction: string | null; baseCurrency: string | null; ownerControlled: boolean; legalStatusConfirmed: boolean; notes: string | null }>({
    mutationFn: (input) => api('/api/entities', { method: 'POST', body: input, schema: Entity }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['entities'] }),
  });
}
