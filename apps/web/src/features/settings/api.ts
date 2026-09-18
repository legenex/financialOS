import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  AiProvider,
  AiProviderInput,
  AppSettings,
  BackupRecord,
  CredentialInput,
  PasswordChangeInput,
  Schedule,
  ScheduleUpdateInput,
  SecurityOverview,
} from '@financialos/contracts';
import { api, listOf, type ApiError } from '../../lib/api';

const settingsKeys = {
  security: ['security'] as const,
  schedules: ['schedules'] as const,
  backups: ['backups'] as const,
};

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation<AppSettings, ApiError, Partial<AppSettings>>({
    mutationFn: (input) => api('/api/settings', { method: 'PUT', body: input, schema: AppSettings }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}

// ---------- Security ----------

export function useSecurityOverview() {
  return useQuery({
    queryKey: settingsKeys.security,
    queryFn: ({ signal }) => api('/api/security', { schema: SecurityOverview, signal }),
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api(`/api/security/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.security }),
  });
}

export function useSetIdleTimeout() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, number>({
    mutationFn: (seconds) => api('/api/security/idle-timeout', { method: 'PUT', body: { seconds } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.security }),
  });
}

export function useChangePassword() {
  return useMutation<unknown, ApiError, z.infer<typeof PasswordChangeInput>>({
    mutationFn: (input) => api('/api/security/password', { method: 'POST', body: input }),
  });
}

// ---------- AI providers ----------

export function useCreateAiProvider() {
  const qc = useQueryClient();
  return useMutation<AiProvider, ApiError, z.infer<typeof AiProviderInput>>({
    mutationFn: (input) => api('/api/ai-providers', { method: 'POST', body: input, schema: AiProvider }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-providers'] }),
  });
}

export function useUpdateAiProvider() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { id: string } & Partial<z.infer<typeof AiProviderInput>>>({
    mutationFn: (input) => api('/api/ai-providers', { method: 'PUT', body: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-providers'] }),
  });
}

export function useSetAiProviderCredentials() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { id: string; input: z.infer<typeof CredentialInput> }>({
    mutationFn: ({ id, input }) => api(`/api/ai-providers/${encodeURIComponent(id)}/credentials`, { method: 'PUT', body: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-providers'] }),
  });
}

const TestResult = z.object({ ok: z.boolean().nullable(), detail: z.string(), jobId: z.string() });

export function useTestAiProvider() {
  return useMutation<z.infer<typeof TestResult>, ApiError, string>({
    mutationFn: (id) => api(`/api/ai-providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: {}, schema: TestResult }),
  });
}

// ---------- Automations (schedules) ----------

export function useSchedules() {
  return useQuery({
    queryKey: settingsKeys.schedules,
    queryFn: ({ signal }) => api('/api/schedules', { schema: listOf(Schedule), signal }),
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation<Schedule, ApiError, { id: string; input: z.infer<typeof ScheduleUpdateInput> }>({
    mutationFn: ({ id, input }) => api(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PUT', body: input, schema: Schedule }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.schedules }),
  });
}

// ---------- Backups ----------

export function useBackups() {
  return useQuery({
    queryKey: settingsKeys.backups,
    queryFn: ({ signal }) => api('/api/backups', { schema: listOf(BackupRecord), signal }),
  });
}

const JobResult = z.object({ jobId: z.string() });

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation<z.infer<typeof JobResult>, ApiError, void>({
    mutationFn: () => api('/api/backups', { method: 'POST', body: {}, schema: JobResult }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.backups }),
  });
}
