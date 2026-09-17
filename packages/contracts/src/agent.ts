import { z } from 'zod';
import { DecimalString, Id, IsoDate, IsoDateTime, SourceLink } from './common';

/** Scopes an agent credential can hold. All are read-only or produce drafts. */
export const AGENT_SCOPES = [
  'read:summary',
  'read:accounts',
  'read:transactions',
  'read:budgets',
  'read:forecast',
  'read:portfolio',
  'read:exceptions',
  'simulate:portfolio',
  'draft:review',
  'suggest:classification',
] as const;
export const AgentScope = z.enum(AGENT_SCOPES);
export type AgentScope = z.infer<typeof AgentScope>;

export const AgentClient = z.object({
  id: Id,
  name: z.string(),
  scopes: z.array(AgentScope),
  entityIds: z.array(Id),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
});
export type AgentClient = z.infer<typeof AgentClient>;

export const AgentClientInput = z.object({
  name: z.string().min(1).max(60),
  scopes: z.array(AgentScope).min(1),
  entityIds: z.array(Id).min(1),
  expiresInDays: z.number().int().min(1).max(365),
});
export type AgentClientInput = z.infer<typeof AgentClientInput>;

export const AgentClientCreated = z.object({
  client: AgentClient,
  /** Shown exactly once. Stored hashed. */
  credential: z.string(),
});
export type AgentClientCreated = z.infer<typeof AgentClientCreated>;

export const AiProvider = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(['openai_compatible', 'anthropic']),
  baseUrl: z.string(),
  model: z.string(),
  locality: z.enum(['local', 'cloud']),
  enabled: z.boolean(),
  hasCredential: z.boolean(),
  allowIdentifiableData: z.boolean(),
  monthlyBudgetUsd: DecimalString.nullable(),
  usedThisMonthUsd: DecimalString,
  taskRouting: z.array(z.enum(['coach_chat', 'summaries', 'classification_suggestions', 'review_drafts'])),
  lastTest: z.object({ at: IsoDateTime, ok: z.boolean(), detail: z.string() }).nullable(),
  isOrchestrator: z.boolean(),
});
export type AiProvider = z.infer<typeof AiProvider>;

export const AiProviderInput = z.object({
  name: z.string().min(1).max(60),
  kind: z.enum(['openai_compatible', 'anthropic']),
  baseUrl: z.string().url().max(300),
  model: z.string().min(1).max(120),
  locality: z.enum(['local', 'cloud']),
  enabled: z.boolean(),
  allowIdentifiableData: z.boolean(),
  monthlyBudgetUsd: DecimalString.nullable(),
  taskRouting: AiProvider.shape.taskRouting,
  isOrchestrator: z.boolean(),
});
export type AiProviderInput = z.infer<typeof AiProviderInput>;

export const CoachMessage = z.object({
  id: Id,
  role: z.enum(['owner', 'coach']),
  content: z.string(),
  /** 'deterministic' means rule-based text computed from records, never presented as model output. */
  generatedBy: z.string(),
  links: z.array(SourceLink),
  createdAt: IsoDateTime,
  status: z.enum(['complete', 'streaming', 'cancelled', 'failed']),
});
export type CoachMessage = z.infer<typeof CoachMessage>;

export const CoachAskInput = z.object({
  threadId: Id.nullable(),
  message: z.string().min(1).max(4000),
  mode: z.enum(['auto', 'deterministic_only']),
});
export type CoachAskInput = z.infer<typeof CoachAskInput>;

export const ReviewKind = z.enum(['weekly', 'monthly']);

export const ReviewSection = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  links: z.array(SourceLink),
});

export const Review = z.object({
  id: Id,
  kind: ReviewKind,
  periodStart: IsoDate,
  periodEnd: IsoDate,
  status: z.enum(['draft', 'in_progress', 'completed']),
  generatedBy: z.string(),
  whatChanged: z.array(ReviewSection),
  whyItMatters: z.array(ReviewSection),
  nextAction: ReviewSection.nullable(),
  checklist: z.array(z.object({ id: z.string(), label: z.string(), done: z.boolean(), href: z.string().nullable() })),
  notes: z.string().nullable(),
  startedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
});
export type Review = z.infer<typeof Review>;

export const Achievement = z.object({
  id: Id,
  kind: z.enum(['review_completed', 'reconciled_account', 'goal_contribution_verified', 'verified_saving', 'exceptions_cleared', 'streak']),
  title: z.string(),
  earnedAt: IsoDateTime,
  evidence: z.array(SourceLink),
});
export type Achievement = z.infer<typeof Achievement>;

export const TradeProposal = z.object({
  id: Id,
  mode: z.literal('paper'),
  instrument: z.string(),
  side: z.enum(['buy', 'sell']),
  quantity: DecimalString,
  limitPrice: DecimalString.nullable(),
  currency: z.string(),
  rationale: z.string(),
  createdBy: z.enum(['owner', 'agent']),
  riskChecks: z.array(z.object({ rule: z.string(), passed: z.boolean(), detail: z.string() })),
  status: z.enum(['draft', 'simulated', 'paper_filled', 'rejected', 'expired']),
  paperFill: z.object({ price: DecimalString, at: IsoDateTime, priceSource: z.string() }).nullable(),
  createdAt: IsoDateTime,
});
export type TradeProposal = z.infer<typeof TradeProposal>;

export const TradeProposalInput = z.object({
  instrument: z.string().min(1).max(40),
  side: z.enum(['buy', 'sell']),
  quantity: DecimalString,
  limitPrice: DecimalString.nullable(),
  currency: z.string().max(10),
  rationale: z.string().max(2000),
});
export type TradeProposalInput = z.infer<typeof TradeProposalInput>;

export const RiskPolicy = z.object({
  maxPositionShare: DecimalString,
  maxSingleOrderValueUsd: DecimalString,
  allowedInstrumentKinds: z.array(z.string()),
  leverageAllowed: z.literal(false),
  version: z.number().int(),
  updatedAt: IsoDateTime,
});
export type RiskPolicy = z.infer<typeof RiskPolicy>;

export const ExecutionStatus = z.object({
  liveExecutionEnabled: z.literal(false),
  reason: z.string(),
  requirements: z.array(z.string()),
});
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;
