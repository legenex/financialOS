import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import {
  Account,
  AccountInput,
  BalanceSnapshot,
  type BalanceSnapshotInput,
  ClassificationInput,
  DocumentRecord,
  Holdings,
  Institution,
  PortfolioSummary,
  Reconciliation,
  Restriction,
  Transaction,
  TransactionPage,
  TransactionQuery,
  WealthSummary,
} from '@financialos/contracts';
import { api, apiUpload, listOf, type ApiError } from '../../lib/api';

const moneyKeys = {
  institutions: ['institutions'] as const,
  snapshots: (accountId: string) => ['accounts', accountId, 'snapshots'] as const,
  holdings: (accountId: string) => ['accounts', accountId, 'holdings'] as const,
  reconciliations: (accountId: string) => ['accounts', accountId, 'reconciliations'] as const,
  transactions: (query: TransactionQuery) => ['transactions', query] as const,
  transaction: (id: string) => ['transactions', id] as const,
  portfolio: (params: Record<string, string | undefined>) => ['portfolio', params] as const,
  restrictions: ['restrictions'] as const,
  documents: (accountId: string | null) => ['documents', accountId] as const,
};

// ---------- Institutions ----------

export function useInstitutions() {
  return useQuery({
    queryKey: moneyKeys.institutions,
    queryFn: ({ signal }) => api('/api/institutions', { schema: listOf(Institution), background: true, signal }),
    staleTime: 5 * 60_000,
  });
}

export function useCreateInstitution() {
  const qc = useQueryClient();
  return useMutation<Institution, ApiError, Pick<Institution, 'name' | 'country' | 'kind' | 'providerKey'>>({
    mutationFn: (input) => api('/api/institutions', { method: 'POST', body: input, schema: Institution }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: moneyKeys.institutions }),
  });
}

// ---------- Accounts ----------

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation<Account, ApiError, AccountInput>({
    mutationFn: (input) => api('/api/accounts', { method: 'POST', body: input, schema: Account }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation<Account, ApiError, { id: string; input: Partial<AccountInput> }>({
    mutationFn: ({ id, input }) => api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: input, schema: Account }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useAccountSnapshots(accountId: string | null) {
  return useQuery({
    queryKey: moneyKeys.snapshots(accountId ?? 'none'),
    queryFn: ({ signal }) => api(`/api/accounts/${encodeURIComponent(accountId ?? '')}/snapshots`, { schema: listOf(BalanceSnapshot), signal }),
    enabled: !!accountId,
  });
}

export function useAddSnapshot(accountId: string) {
  const qc = useQueryClient();
  return useMutation<BalanceSnapshot, ApiError, BalanceSnapshotInput>({
    mutationFn: (input) => api(`/api/accounts/${encodeURIComponent(accountId)}/snapshots`, { method: 'POST', body: input, schema: BalanceSnapshot }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: moneyKeys.snapshots(accountId) });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useHoldings(accountId: string | null) {
  return useQuery({
    queryKey: moneyKeys.holdings(accountId ?? 'none'),
    queryFn: ({ signal }) => api(`/api/accounts/${encodeURIComponent(accountId ?? '')}/holdings`, { schema: Holdings, signal }),
    enabled: !!accountId,
  });
}

export function useReconciliations(accountId: string | null) {
  return useQuery({
    queryKey: moneyKeys.reconciliations(accountId ?? 'none'),
    queryFn: ({ signal }) => api(`/api/accounts/${encodeURIComponent(accountId ?? '')}/reconciliations`, { schema: listOf(Reconciliation), signal }),
    enabled: !!accountId,
  });
}

// ---------- Transactions ----------

export function useTransactions(query: TransactionQuery, options: QueryOpts<TransactionPage> = {}) {
  return useQuery({
    queryKey: moneyKeys.transactions(query),
    queryFn: ({ signal }) => api('/api/transactions', { schema: TransactionPage, query: { ...query }, signal }),
    ...options,
  });
}
type QueryOpts<T> = Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>;

export function useTransaction(id: string | null) {
  return useQuery({
    queryKey: moneyKeys.transaction(id ?? 'none'),
    queryFn: ({ signal }) => api(`/api/transactions/${encodeURIComponent(id ?? '')}`, { schema: Transaction, signal }),
    enabled: !!id,
  });
}

export function useClassifyTransaction() {
  const qc = useQueryClient();
  return useMutation<Transaction, ApiError, { id: string; input: ClassificationInput }>({
    mutationFn: ({ id, input }) => api(`/api/transactions/${encodeURIComponent(id)}/classify`, { method: 'POST', body: input, schema: Transaction }),
    onSuccess: (tx) => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.setQueryData(moneyKeys.transaction(tx.id), tx);
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useTransferMatchAction() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { matchId: string; action: 'confirm' | 'reject' }>({
    mutationFn: ({ matchId, action }) => api(`/api/transfer-matches/${encodeURIComponent(matchId)}`, { method: 'POST', body: { action } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['transactions'] }),
  });
}

export function transactionsExportUrl(query: TransactionQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `/api/transactions/export.csv?${qs}` : '/api/transactions/export.csv';
}

// ---------- Portfolio & restrictions ----------

export function usePortfolio(params: { entityId?: string; scope?: 'personal' | 'consolidated' | 'entity' } = {}) {
  return useQuery({
    queryKey: moneyKeys.portfolio(params),
    queryFn: ({ signal }) => api('/api/portfolio', { schema: PortfolioSummary, query: { ...params }, signal }),
  });
}

export function useRestrictions() {
  return useQuery({
    queryKey: moneyKeys.restrictions,
    queryFn: ({ signal }) => api('/api/restrictions', { schema: listOf(Restriction), signal }),
  });
}

export function useSaveRestriction() {
  const qc = useQueryClient();
  return useMutation<Restriction, ApiError, { id: string | null; input: Omit<Restriction, 'id'> }>({
    mutationFn: ({ id, input }) =>
      id
        ? api(`/api/restrictions/${encodeURIComponent(id)}`, { method: 'PATCH', body: input, schema: Restriction })
        : api('/api/restrictions', { method: 'POST', body: input, schema: Restriction }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: moneyKeys.restrictions }),
  });
}

export function useWealth(params: { scope?: 'personal' | 'consolidated' | 'entity'; entityId?: string } = {}) {
  return useQuery({
    queryKey: ['wealth', params],
    queryFn: ({ signal }) => api('/api/wealth', { schema: WealthSummary, query: { ...params }, signal }),
  });
}

// ---------- Documents ----------

export function useDocuments(accountId: string | null = null) {
  return useQuery({
    queryKey: moneyKeys.documents(accountId),
    queryFn: ({ signal }) => api('/api/documents', { schema: listOf(DocumentRecord), query: accountId ? { accountId } : undefined, signal }),
  });
}

export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation<
    DocumentRecord,
    ApiError,
    { file: File; kind: DocumentRecord['kind']; accountId: string | null; entityId: string | null; note: string | null }
  >({
    mutationFn: ({ file, kind, accountId, entityId, note }) => {
      const form = new FormData();
      form.set('file', file);
      form.set('kind', kind);
      if (accountId) form.set('accountId', accountId);
      if (entityId) form.set('entityId', entityId);
      if (note) form.set('note', note);
      return apiUpload('/api/documents', form, { schema: DocumentRecord });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['documents'] }),
  });
}

export function documentDownloadUrl(id: string): string {
  return `/api/documents/${encodeURIComponent(id)}/download`;
}
