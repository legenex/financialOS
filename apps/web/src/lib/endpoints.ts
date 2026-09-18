import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import {
  Account,
  Achievement,
  AiProvider,
  AppSettings,
  Budget,
  Category,
  CoachMessage,
  Entity,
  ExceptionItem,
  Goal,
  GoalContribution,
  LaunchInfo,
  LoginResult,
  Notification,
  Obligation,
  PurchaseImpactResult,
  RecoveryCodes,
  RecurringItem,
  Review,
  Scenario,
  SearchResult,
  SetupStatus,
  TodayResponse,
  TotpEnrollment,
  type BudgetInput,
  type CoachAskInput,
  type ExceptionResolveInput,
  type GoalContributionInput,
  type GoalInput,
  type ObligationInput,
  type PasswordLoginInput,
  type PurchaseImpactInput,
  type RecurringItemInput,
} from '@financialos/contracts';
import { api, listOf, type ApiError } from './api';
import type { ApiScopeParams } from './context';

/**
 * One hook per endpoint used by the core screens. Pattern (see apps/web/HANDOFF.md):
 *   - query keys start with the resource name and include every parameter;
 *   - schemas come from @financialos/contracts;
 *   - polling uses `background: true`;
 *   - mutations invalidate the resources they change.
 */

type QueryOpts<T> = Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>;

export const keys = {
  setupStatus: ['setup', 'status'] as const,
  launch: ['auth', 'launch'] as const,
  today: (p: ApiScopeParams) => ['today', p] as const,
  settings: ['settings'] as const,
  entities: ['entities'] as const,
  scenarios: ['scenarios'] as const,
  accounts: ['accounts'] as const,
  categories: ['categories'] as const,
  notifications: ['notifications'] as const,
  exceptions: (status: string | null, kind: string | null) => ['exceptions', { status, kind }] as const,
  search: (q: string) => ['search', q] as const,
  budgets: (period: string) => ['budgets', period] as const,
  goals: ['goals'] as const,
  contributions: (goalId: string) => ['goals', goalId, 'contributions'] as const,
  recurring: (status: string | null) => ['recurring', status] as const,
  obligations: ['obligations'] as const,
  aiProviders: ['ai-providers'] as const,
  coachThreads: ['coach', 'threads'] as const,
  coachThread: (id: string) => ['coach', 'threads', id] as const,
  reviews: ['reviews'] as const,
  achievements: ['achievements'] as const,
};

// ---------- Setup & auth (public) ----------

export function useSetupStatus(options: QueryOpts<SetupStatus> = {}) {
  return useQuery({
    queryKey: keys.setupStatus,
    queryFn: ({ signal }) => api('/api/setup/status', { schema: SetupStatus, public: true, background: true, signal }),
    staleTime: 0,
    ...options,
  });
}

export const setupApi = {
  begin: (bootstrapSecret: string) => api('/api/setup/begin', { method: 'POST', body: { bootstrapSecret }, schema: SetupStatus, public: true }),
  owner: (displayName: string, password: string) =>
    api('/api/setup/owner', { method: 'POST', body: { displayName, password }, schema: SetupStatus, public: true }),
  totpStart: () => api('/api/setup/totp/start', { method: 'POST', body: {}, schema: TotpEnrollment, public: true }),
  totpVerify: (code: string) => api('/api/setup/totp/verify', { method: 'POST', body: { code }, schema: SetupStatus, public: true }),
  recoveryCodes: () => api('/api/setup/recovery-codes', { method: 'POST', body: {}, schema: RecoveryCodes, public: true }),
  passkeyOptions: () => api('/api/setup/passkey/options', { method: 'POST', body: {}, schema: z.record(z.string(), z.unknown()), public: true }),
  passkeyVerify: (response: Record<string, unknown>) =>
    api('/api/setup/passkey/verify', { method: 'POST', body: { response }, schema: SetupStatus, public: true }),
  seal: () => api('/api/setup/seal', { method: 'POST', body: {}, schema: SetupStatus, public: true }),
};

export function useLaunchInfo(enabled: boolean) {
  return useQuery({
    queryKey: keys.launch,
    queryFn: ({ signal }) => api('/api/auth/launch', { schema: LaunchInfo, public: true, background: true, signal }),
    enabled,
    staleTime: 0,
    gcTime: 0,
  });
}

export const authApi = {
  loginPassword: (input: PasswordLoginInput) => api('/api/auth/login/password', { method: 'POST', body: input, schema: LoginResult, public: true }),
  passkeyOptions: (launchId?: string) =>
    api('/api/auth/passkey/options', { method: 'POST', body: launchId ? { launchId } : {}, schema: z.record(z.string(), z.unknown()), public: true }),
  passkeyVerify: (response: Record<string, unknown>, launchId?: string) =>
    api('/api/auth/passkey/verify', { method: 'POST', body: { response, ...(launchId ? { launchId } : {}) }, schema: LoginResult, public: true }),
};

// ---------- Today, settings, context ----------

export function useToday(params: ApiScopeParams, options: QueryOpts<TodayResponse> = {}) {
  return useQuery({
    queryKey: keys.today(params),
    queryFn: ({ signal }) => api('/api/today', { schema: TodayResponse, query: { ...params }, signal }),
    ...options,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: ({ signal }) => api('/api/settings', { schema: AppSettings, background: true, signal }),
    staleTime: 5 * 60_000,
  });
}

export function useEntities() {
  return useQuery({
    queryKey: keys.entities,
    queryFn: ({ signal }) => api('/api/entities', { schema: listOf(Entity), background: true, signal }),
    staleTime: 5 * 60_000,
  });
}

export function useScenarios() {
  return useQuery({
    queryKey: keys.scenarios,
    queryFn: ({ signal }) => api('/api/scenarios', { schema: listOf(Scenario), background: true, signal }),
    staleTime: 5 * 60_000,
  });
}

export function useAccounts(enabled = true) {
  return useQuery({
    queryKey: keys.accounts,
    queryFn: ({ signal }) => api('/api/accounts', { schema: listOf(Account), signal }),
    enabled,
  });
}

export function useCategories(enabled = true) {
  return useQuery({
    queryKey: keys.categories,
    queryFn: ({ signal }) => api('/api/categories', { schema: listOf(Category), signal }),
    enabled,
    staleTime: 5 * 60_000,
  });
}

const NotificationList = z.object({ items: z.array(Notification), unread: z.number().int() });

export function useNotifications(poll = true) {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: ({ signal }) => api('/api/notifications', { schema: NotificationList, background: true, signal }),
    refetchInterval: poll ? 60_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, string | 'all'>({
    mutationFn: (id) => api(id === 'all' ? '/api/notifications/read-all' : `/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

// ---------- Exceptions & search ----------

const ExceptionList = z.object({ items: z.array(ExceptionItem) });

export function useExceptions(status: string | null, kind: string | null, options: { background?: boolean; poll?: boolean } = {}) {
  return useQuery({
    queryKey: keys.exceptions(status, kind),
    queryFn: ({ signal }) =>
      api('/api/exceptions', { schema: ExceptionList, query: { status, kind }, background: options.background, signal }).then((r) => r.items),
    refetchInterval: options.poll ? 60_000 : false,
  });
}

export function useResolveException() {
  const qc = useQueryClient();
  return useMutation<ExceptionItem, ApiError, { id: string; input: ExceptionResolveInput }>({
    mutationFn: ({ id, input }) => api(`/api/exceptions/${encodeURIComponent(id)}`, { method: 'POST', body: input, schema: ExceptionItem }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['exceptions'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: keys.search(term),
    queryFn: ({ signal }) => api('/api/search', { schema: SearchResult, query: { q: term }, background: true, signal }),
    enabled: term.length >= 2,
    staleTime: 30_000,
    gcTime: 30_000,
  });
}

// ---------- Plan ----------

export function useBudgets(period: string) {
  return useQuery({
    queryKey: keys.budgets(period),
    queryFn: ({ signal }) => api('/api/budgets', { schema: listOf(Budget), query: { period }, signal }),
  });
}

export function useSaveBudget(period: string) {
  const qc = useQueryClient();
  return useMutation<Budget, ApiError, { id: string | null; input: BudgetInput }>({
    mutationFn: ({ id, input }) =>
      id
        ? api(`/api/budgets/${encodeURIComponent(id)}`, { method: 'PUT', body: input, schema: Budget })
        : api('/api/budgets', { method: 'POST', body: input, schema: Budget }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.budgets(period) });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useGoals() {
  return useQuery({
    queryKey: keys.goals,
    queryFn: ({ signal }) => api('/api/goals', { schema: listOf(Goal), signal }),
  });
}

export function useSaveGoal() {
  const qc = useQueryClient();
  return useMutation<Goal, ApiError, { id: string | null; input: GoalInput }>({
    mutationFn: ({ id, input }) =>
      id
        ? api(`/api/goals/${encodeURIComponent(id)}`, { method: 'PUT', body: input, schema: Goal })
        : api('/api/goals', { method: 'POST', body: input, schema: Goal }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.goals });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api(`/api/goals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.goals });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useGoalContributions(goalId: string | null) {
  return useQuery({
    queryKey: keys.contributions(goalId ?? 'none'),
    queryFn: ({ signal }) => api(`/api/goals/${encodeURIComponent(goalId ?? '')}/contributions`, { schema: listOf(GoalContribution), signal }),
    enabled: !!goalId,
  });
}

export function useAddContribution(goalId: string) {
  const qc = useQueryClient();
  return useMutation<GoalContribution, ApiError, GoalContributionInput>({
    mutationFn: (input) => api(`/api/goals/${encodeURIComponent(goalId)}/contributions`, { method: 'POST', body: input, schema: GoalContribution }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.contributions(goalId) });
      void qc.invalidateQueries({ queryKey: keys.goals });
    },
  });
}

export function useRecurring(status: 'suggested' | null) {
  return useQuery({
    queryKey: keys.recurring(status),
    queryFn: ({ signal }) => api('/api/recurring', { schema: listOf(RecurringItem), query: { status }, signal }),
  });
}

export function useSaveRecurring() {
  const qc = useQueryClient();
  return useMutation<RecurringItem, ApiError, { id: string | null; input: RecurringItemInput }>({
    mutationFn: ({ id, input }) =>
      id
        ? api(`/api/recurring/${encodeURIComponent(id)}`, { method: 'PUT', body: input, schema: RecurringItem })
        : api('/api/recurring', { method: 'POST', body: input, schema: RecurringItem }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useRecurringDecision() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { id: string; decision: 'confirm' | 'dismiss' }>({
    mutationFn: ({ id, decision }) => api(`/api/recurring/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function useObligations() {
  return useQuery({
    queryKey: keys.obligations,
    queryFn: ({ signal }) => api('/api/obligations', { schema: listOf(Obligation), signal }),
  });
}

export function useSaveObligation() {
  const qc = useQueryClient();
  return useMutation<Obligation, ApiError, { id: string | null; input: ObligationInput }>({
    mutationFn: ({ id, input }) =>
      id
        ? api(`/api/obligations/${encodeURIComponent(id)}`, { method: 'PUT', body: input, schema: Obligation })
        : api('/api/obligations', { method: 'POST', body: input, schema: Obligation }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.obligations });
      void qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}

export function usePurchaseImpact() {
  return useMutation<PurchaseImpactResult, ApiError, PurchaseImpactInput>({
    mutationFn: (input) => api('/api/plan/purchase-impact', { method: 'POST', body: input, schema: PurchaseImpactResult }),
  });
}

// ---------- Coach ----------

export function useAiProviders() {
  return useQuery({
    queryKey: keys.aiProviders,
    queryFn: ({ signal }) => api('/api/ai-providers', { schema: listOf(AiProvider), background: true, signal }),
    staleTime: 5 * 60_000,
  });
}

export const CoachThreadSummary = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    lastMessageAt: z.string().nullable().optional(),
  })
  .loose();
export type CoachThreadSummary = z.infer<typeof CoachThreadSummary>;

export function useCoachThreads() {
  return useQuery({
    queryKey: keys.coachThreads,
    queryFn: ({ signal }) => api('/api/coach/threads', { schema: listOf(CoachThreadSummary), signal }),
  });
}

const ThreadMessages = z
  .union([z.array(CoachMessage), z.object({ messages: z.array(CoachMessage) }).loose(), z.object({ items: z.array(CoachMessage) }).loose()])
  .transform((v) => (Array.isArray(v) ? v : 'messages' in v ? (v.messages as CoachMessage[]) : (v.items as CoachMessage[])));

export function useCoachThread(id: string | null) {
  return useQuery({
    queryKey: keys.coachThread(id ?? 'none'),
    queryFn: ({ signal }) => api(`/api/coach/threads/${encodeURIComponent(id ?? '')}`, { schema: ThreadMessages, signal, background: true }),
    enabled: !!id,
    // Poll while the last message is still being generated; a complete/failed/cancelled thread never refetches.
    refetchInterval: (query) => {
      const messages = query.state.data as CoachMessage[] | undefined;
      const last = messages?.[messages.length - 1];
      return last?.status === 'streaming' ? 1200 : false;
    },
  });
}

const AskResult = z.object({ threadId: z.string(), messageId: z.string() });

export const coachApi = {
  ask: (input: CoachAskInput) => api('/api/coach/ask', { method: 'POST', body: input, schema: AskResult }),
  cancel: (messageId: string) => api(`/api/coach/messages/${encodeURIComponent(messageId)}/cancel`, { method: 'POST', body: {} }),
};

export function useAskCoach() {
  const qc = useQueryClient();
  return useMutation<{ threadId: string; messageId: string }, ApiError, CoachAskInput>({
    mutationFn: (input) => coachApi.ask(input),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: keys.coachThreads });
      void qc.invalidateQueries({ queryKey: keys.coachThread(result.threadId) });
    },
  });
}

export function useReviews() {
  return useQuery({
    queryKey: keys.reviews,
    queryFn: ({ signal }) => api('/api/reviews', { schema: listOf(Review), signal }),
  });
}

export function useStartReview() {
  const qc = useQueryClient();
  return useMutation<Review, ApiError, 'weekly' | 'monthly'>({
    mutationFn: (kind) => api('/api/reviews', { method: 'POST', body: { kind }, schema: Review }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.reviews }),
  });
}

export interface ReviewPatch {
  checklist?: Array<{ id: string; done: boolean }>;
  notes?: string | null;
  complete?: boolean;
}

export function useUpdateReview() {
  const qc = useQueryClient();
  return useMutation<Review, ApiError, { id: string; patch: ReviewPatch }>({
    mutationFn: ({ id, patch }) => api(`/api/reviews/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, schema: Review }),
    onSuccess: (review) => {
      qc.setQueryData<Review[]>(keys.reviews, (list) => list?.map((r) => (r.id === review.id ? review : r)));
      void qc.invalidateQueries({ queryKey: keys.reviews });
      void qc.invalidateQueries({ queryKey: keys.achievements });
    },
  });
}

export function useAchievements() {
  return useQuery({
    queryKey: keys.achievements,
    queryFn: ({ signal }) => api('/api/achievements', { schema: listOf(Achievement), signal }),
  });
}
