import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  AccountMappingInput,
  BackfillInput,
  Connection,
  ConnectionCreateInput,
  ConnectionUpdateInput,
  CredentialInput,
  OAuthStartResult,
  ProviderDescriptor,
} from '@financialos/contracts';
import { api, listOf, type ApiError } from '../../lib/api';

const connectionsKeys = {
  providers: ['providers'] as const,
  connections: ['connections'] as const,
  connection: (id: string) => ['connections', id] as const,
};

const ProviderList = z.object({ items: z.array(ProviderDescriptor), available: z.array(z.string()), note: z.string().optional() });
const JobResult = z.object({ jobId: z.string() });

export function useProviders() {
  return useQuery({
    queryKey: connectionsKeys.providers,
    queryFn: ({ signal }) => api('/api/providers', { schema: ProviderList, background: true, signal }),
    staleTime: 5 * 60_000,
  });
}

export function useConnections() {
  return useQuery({
    queryKey: connectionsKeys.connections,
    queryFn: ({ signal }) => api('/api/connections', { schema: listOf(Connection), signal }),
  });
}

export function useCreateConnection() {
  const qc = useQueryClient();
  return useMutation<Connection, ApiError, ConnectionCreateInput>({
    mutationFn: (input) => api('/api/connections', { method: 'POST', body: input, schema: Connection }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: connectionsKeys.connections }),
  });
}

export function useUpdateConnection() {
  const qc = useQueryClient();
  return useMutation<Connection, ApiError, { id: string; input: ConnectionUpdateInput }>({
    mutationFn: ({ id, input }) => api(`/api/connections/${encodeURIComponent(id)}`, { method: 'PATCH', body: input, schema: Connection }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: connectionsKeys.connections }),
  });
}

export function useRevokeConnection() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: connectionsKeys.connections }),
  });
}

export function useSetConnectionCredentials() {
  const qc = useQueryClient();
  return useMutation<Connection, ApiError, { id: string; input: CredentialInput }>({
    mutationFn: ({ id, input }) => api(`/api/connections/${encodeURIComponent(id)}/credentials`, { method: 'PUT', body: input, schema: Connection }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: connectionsKeys.connections }),
  });
}

export function useRemoveConnectionCredentials() {
  const qc = useQueryClient();
  return useMutation<Connection, ApiError, string>({
    mutationFn: (id) => api(`/api/connections/${encodeURIComponent(id)}/credentials`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: connectionsKeys.connections }),
  });
}

function useConnectionJob(path: (id: string) => string) {
  const qc = useQueryClient();
  return useMutation<{ jobId: string }, ApiError, string>({
    mutationFn: (id) => api(path(id), { method: 'POST', body: {}, schema: JobResult }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: connectionsKeys.connections }),
  });
}

export function useTestConnection() {
  return useConnectionJob((id) => `/api/connections/${encodeURIComponent(id)}/test`);
}

export function useDiscoverAccounts() {
  return useConnectionJob((id) => `/api/connections/${encodeURIComponent(id)}/discover-accounts`);
}

export function useSyncConnection() {
  return useConnectionJob((id) => `/api/connections/${encodeURIComponent(id)}/sync`);
}

export function useBackfillConnection() {
  const qc = useQueryClient();
  return useMutation<{ jobId: string }, ApiError, { id: string; input: BackfillInput }>({
    mutationFn: ({ id, input }) => api(`/api/connections/${encodeURIComponent(id)}/backfill`, { method: 'POST', body: input, schema: JobResult }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: connectionsKeys.connections }),
  });
}

export function useMapAccounts() {
  const qc = useQueryClient();
  return useMutation<Connection, ApiError, { id: string; input: AccountMappingInput }>({
    mutationFn: ({ id, input }) => api(`/api/connections/${encodeURIComponent(id)}/accounts`, { method: 'PUT', body: input, schema: Connection }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: connectionsKeys.connections }),
  });
}

export function useStartOAuth() {
  return useMutation<OAuthStartResult, ApiError, string>({
    mutationFn: (id) => api(`/api/connections/${encodeURIComponent(id)}/oauth/start`, { method: 'POST', body: {}, schema: OAuthStartResult }),
  });
}
