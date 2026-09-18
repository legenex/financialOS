import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ImportBatch, ImportConfigureInput, PreviewRow, type ImportFileKind } from '@financialos/contracts';
import { api, apiUpload, listOf, type ApiError } from '../../lib/api';

const JobResult = z.object({ jobId: z.string() });

const importsKeys = {
  batch: (id: string) => ['imports', id] as const,
  preview: (id: string, status: string | null) => ['imports', id, 'preview', status] as const,
};

export function useUploadImport() {
  const qc = useQueryClient();
  return useMutation<ImportBatch, ApiError, File>({
    mutationFn: (file) => {
      const form = new FormData();
      form.set('file', file);
      return apiUpload('/api/imports', form, { schema: ImportBatch });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['imports'] }),
  });
}

export function useImportBatch(id: string | null, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: importsKeys.batch(id ?? 'none'),
    queryFn: ({ signal }) => api(`/api/imports/${encodeURIComponent(id ?? '')}`, { schema: ImportBatch, background: true, signal }),
    enabled: !!id,
    refetchInterval: (query) => {
      if (!options.poll) return false;
      const status = query.state.data?.status;
      return status === 'parsing' || status === 'committing' || status === 'reversing' ? 1000 : false;
    },
  });
}

export function useConfigureImport() {
  const qc = useQueryClient();
  return useMutation<ImportBatch, ApiError, { id: string; input: ImportConfigureInput }>({
    mutationFn: ({ id, input }) => api(`/api/imports/${encodeURIComponent(id)}/configure`, { method: 'POST', body: input, schema: ImportBatch }),
    onSuccess: (batch) => void qc.setQueryData(importsKeys.batch(batch.id), batch),
  });
}

export function useImportPreview(id: string | null, status: string | null) {
  return useQuery({
    queryKey: importsKeys.preview(id ?? 'none', status),
    queryFn: ({ signal }) =>
      api(`/api/imports/${encodeURIComponent(id ?? '')}/preview`, { schema: listOf(PreviewRow), query: status ? { status } : undefined, signal }),
    enabled: !!id,
  });
}

export function useCommitImport() {
  const qc = useQueryClient();
  return useMutation<{ jobId: string }, ApiError, { id: string; includePossibleDuplicates: number[] }>({
    mutationFn: ({ id, includePossibleDuplicates }) =>
      api(`/api/imports/${encodeURIComponent(id)}/commit`, {
        method: 'POST',
        body: { includePossibleDuplicates, idempotencyKey: `web:${id}:${Date.now()}` },
        schema: JobResult,
      }),
    onSuccess: (_r, vars) => void qc.invalidateQueries({ queryKey: importsKeys.batch(vars.id) }),
  });
}

export function useCancelImport() {
  const qc = useQueryClient();
  return useMutation<ImportBatch, ApiError, string>({
    mutationFn: (id) => api(`/api/imports/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {}, schema: ImportBatch }),
    onSuccess: (batch) => void qc.setQueryData(importsKeys.batch(batch.id), batch),
  });
}

export type { ImportFileKind };
