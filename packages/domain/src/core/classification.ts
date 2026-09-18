/**
 * Deterministic classification rules engine and versioned classifications.
 *
 * - Conditions are plain comparisons on normalised text (case-insensitive, whitespace collapsed). User-supplied
 *   regular expressions are not supported, which rules out ReDoS.
 * - All conditions of a rule must match. Rules run in a fixed order: `priority` descending, then `id`.
 *   For each field the first matching rule that sets it wins; tags are unioned.
 * - Economic owner precedence: ownership rules (card-level / pattern) > general rules > the account's confirmed
 *   owner > unknown. A rule may only set an owner when it has an identity condition (account, card, counterparty
 *   or description): ownership is never inferred from currency, amount or direction alone.
 * - Results below the review threshold, with an unknown owner, or with conflicting ownership rules are flagged
 *   `needsReview`.
 */
import type { Confidence, SplitLine, TransactionNature } from '@financialos/contracts';
import { dec, money } from '../money';
import { percentagesSumTo100, splitAmount, SplitError, type SplitShare } from './split';
import type { IsoDateTime, TransactionLike } from './types';

// ---------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------

export type TextMatchOp = 'contains' | 'startsWith' | 'equals';

export type RuleCondition =
  | { kind: 'description'; op: TextMatchOp; value: string }
  | { kind: 'counterparty'; op: TextMatchOp; value: string }
  /** Inclusive range on the absolute amount. Either bound may be null. */
  | { kind: 'amount_range'; min: string | null; max: string | null }
  | { kind: 'direction'; value: 'in' | 'out' }
  | { kind: 'currency'; value: string }
  | { kind: 'account'; accountIds: readonly string[] }
  | { kind: 'card_last4'; value: string };

export type SplitTemplateShare = { kind: 'percent'; percent: string } | { kind: 'fixed'; amount: string };

export interface SplitTemplatePart {
  share: SplitTemplateShare;
  categoryId: string | null;
  nature: TransactionNature;
  /** Null = the transaction's resolved owner. */
  economicOwnerEntityId: string | null;
  memo: string | null;
}

/**
 * Percent parts share whatever the fixed parts leave; when present they must sum to exactly 100.
 * Fixed amounts are magnitudes whose sign follows the transaction.
 */
export interface SplitTemplate {
  parts: readonly SplitTemplatePart[];
}

export interface RuleActions {
  categoryId?: string | null;
  nature?: TransactionNature;
  economicOwnerEntityId?: string;
  split?: SplitTemplate;
  tags?: readonly string[];
}

export type RuleConfidence = 'high' | 'medium' | 'low';

export interface ClassificationRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Higher runs first. Ties are broken by id. */
  priority: number;
  /** `ownership` rules (card-level and ownership patterns) take precedence when resolving the economic owner. */
  kind: 'general' | 'ownership';
  conditions: readonly RuleCondition[];
  actions: RuleActions;
  confidence: RuleConfidence;
}

export interface ClassifiableTransaction extends TransactionLike {
  cardLast4?: string | null;
}

export interface AccountOwnership {
  accountId: string;
  economicOwnerEntityId: string | null;
  confirmed: boolean;
}

export interface ClassifyOptions {
  accounts?: readonly AccountOwnership[];
  /** Results with lower confidence need review. Default `high`. */
  reviewThreshold?: RuleConfidence;
}

export type ClassificationField = 'category' | 'nature' | 'owner' | 'split' | 'tags' | 'review' | 'rule';

export interface ClassificationExplanationLine {
  field: ClassificationField;
  ruleId: string | null;
  ruleName: string | null;
  detail: string;
}

export type OwnerSource = 'ownership_rule' | 'rule' | 'account' | 'unknown';

export interface ClassificationOutcome {
  transactionId: string;
  method: 'rule' | 'none';
  categoryId: string | null;
  nature: TransactionNature;
  economicOwnerEntityId: string | null;
  ownerSource: OwnerSource;
  splits: SplitLine[] | null;
  tags: string[];
  confidence: Confidence;
  needsReview: boolean;
  reviewReasons: string[];
  matchedRuleIds: string[];
  explanation: ClassificationExplanationLine[];
}

// ---------------------------------------------------------------------------------------------------------
// Normalisation and rule validation
// ---------------------------------------------------------------------------------------------------------

const MAX_TEXT = 200;

/** Unicode-normalised, lower-cased text with whitespace collapsed to single spaces. */
export function normaliseText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

const CONFIDENCE_RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };

export function confidenceRank(value: Confidence): number {
  return CONFIDENCE_RANK[value];
}

export function minConfidence(values: readonly Confidence[]): Confidence {
  if (values.length === 0) return 'none';
  return values.reduce((lowest, v) => (CONFIDENCE_RANK[v] < CONFIDENCE_RANK[lowest] ? v : lowest));
}

const IDENTITY_KINDS: ReadonlySet<RuleCondition['kind']> = new Set(['account', 'card_last4', 'counterparty', 'description']);

/** True when a rule has at least one condition that identifies who is transacting. */
export function hasIdentityCondition(rule: Pick<ClassificationRule, 'conditions'>): boolean {
  return rule.conditions.some((c) => IDENTITY_KINDS.has(c.kind));
}

function isDecimal(value: string | null): boolean {
  if (value === null) return true;
  try {
    dec(value);
    return true;
  } catch {
    return false;
  }
}

export function validateSplitTemplate(template: SplitTemplate): string[] {
  const issues: string[] = [];
  if (template.parts.length === 0) issues.push('A split template needs at least one part');
  const percents: string[] = [];
  template.parts.forEach((part, index) => {
    const value = part.share.kind === 'percent' ? part.share.percent : part.share.amount;
    if (!isDecimal(value)) {
      issues.push(`Split part ${index + 1}: invalid ${part.share.kind} value`);
      return;
    }
    if (dec(value).isNegative()) issues.push(`Split part ${index + 1}: ${part.share.kind} must not be negative`);
    if (part.share.kind === 'percent') percents.push(part.share.percent);
  });
  if (percents.length > 0 && percents.every((p) => isDecimal(p)) && !percentagesSumTo100(percents)) {
    issues.push('Split percentages must sum to exactly 100');
  }
  return issues;
}

/** Returns human-readable problems with a rule; an empty list means the rule is usable. */
export function validateRule(rule: ClassificationRule): string[] {
  const issues: string[] = [];
  if (!rule.id) issues.push('Rule id is required');
  if (!rule.name || rule.name.trim() === '') issues.push('Rule name is required');
  if (!Number.isInteger(rule.priority)) issues.push('Rule priority must be an integer');
  if (rule.conditions.length === 0) issues.push('A rule needs at least one condition');
  rule.conditions.forEach((c, index) => {
    const at = `Condition ${index + 1}`;
    switch (c.kind) {
      case 'description':
      case 'counterparty':
        if (normaliseText(c.value) === '') issues.push(`${at}: text must not be empty`);
        if (c.value.length > MAX_TEXT) issues.push(`${at}: text is longer than ${MAX_TEXT} characters`);
        if (!['contains', 'startsWith', 'equals'].includes(c.op)) issues.push(`${at}: unsupported operator`);
        break;
      case 'amount_range':
        if (c.min === null && c.max === null) issues.push(`${at}: an amount range needs a bound`);
        if (!isDecimal(c.min) || !isDecimal(c.max)) issues.push(`${at}: bounds must be decimal strings`);
        else if (c.min !== null && c.max !== null && dec(c.min).greaterThan(dec(c.max))) issues.push(`${at}: min is greater than max`);
        break;
      case 'direction':
        if (c.value !== 'in' && c.value !== 'out') issues.push(`${at}: direction must be in or out`);
        break;
      case 'currency':
        if (!/^[A-Z0-9]{2,10}$/.test(c.value)) issues.push(`${at}: invalid currency code`);
        break;
      case 'account':
        if (c.accountIds.length === 0 || c.accountIds.some((id) => !id)) issues.push(`${at}: account list must not be empty`);
        break;
      case 'card_last4':
        if (!/^\d{4}$/.test(c.value)) issues.push(`${at}: card last-4 must be four digits`);
        break;
      default:
        issues.push(`${at}: unsupported condition`);
    }
  });
  if (rule.kind === 'ownership' && !rule.actions.economicOwnerEntityId) issues.push('An ownership rule must set an economic owner');
  if (rule.actions.economicOwnerEntityId && !hasIdentityCondition(rule)) {
    issues.push('A rule that sets an economic owner needs an account, card, counterparty or description condition; ownership is never inferred from currency, amount or direction alone');
  }
  if (rule.actions.split) issues.push(...validateSplitTemplate(rule.actions.split));
  return issues;
}

// ---------------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------------

function textMatches(op: TextMatchOp, haystack: string, needle: string): boolean {
  const h = normaliseText(haystack);
  const n = normaliseText(needle);
  if (n === '') return false;
  switch (op) {
    case 'contains':
      return h.includes(n);
    case 'startsWith':
      return h.startsWith(n);
    case 'equals':
      return h === n;
  }
}

export function conditionMatches(condition: RuleCondition, tx: ClassifiableTransaction): boolean {
  switch (condition.kind) {
    case 'description':
      return textMatches(condition.op, tx.description, condition.value);
    case 'counterparty':
      return tx.counterparty ? textMatches(condition.op, tx.counterparty, condition.value) : false;
    case 'amount_range': {
      const magnitude = dec(tx.amount.amount).abs();
      if (condition.min !== null && magnitude.lessThan(dec(condition.min))) return false;
      if (condition.max !== null && magnitude.greaterThan(dec(condition.max))) return false;
      return true;
    }
    case 'direction': {
      const amount = dec(tx.amount.amount);
      return condition.value === 'in' ? amount.greaterThan(0) : amount.lessThan(0);
    }
    case 'currency':
      return tx.amount.currency === condition.value;
    case 'account':
      return condition.accountIds.includes(tx.accountId);
    case 'card_last4':
      return (tx.cardLast4 ?? null) === condition.value;
  }
}

export function ruleMatches(rule: ClassificationRule, tx: ClassifiableTransaction): boolean {
  return rule.conditions.length > 0 && rule.conditions.every((c) => conditionMatches(c, tx));
}

/** Deterministic evaluation order: priority descending, then id ascending. */
export function orderRules(rules: readonly ClassificationRule[]): ClassificationRule[] {
  return [...rules].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function describeConditions(rule: ClassificationRule): string {
  return rule.conditions
    .map((c) => {
      switch (c.kind) {
        case 'description':
        case 'counterparty':
          return `${c.kind} ${c.op} "${normaliseText(c.value)}"`;
        case 'amount_range':
          return `amount between ${c.min ?? '-∞'} and ${c.max ?? '∞'}`;
        case 'direction':
          return `direction ${c.value}`;
        case 'currency':
          return `currency ${c.value}`;
        case 'account':
          return `account in [${c.accountIds.join(', ')}]`;
        case 'card_last4':
          return `card ending ${c.value}`;
      }
    })
    .join(' and ');
}

// ---------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------

function toShares(template: SplitTemplate): SplitShare[] {
  return template.parts.map((p) => (p.share.kind === 'percent' ? { kind: 'weight', weight: p.share.percent } : { kind: 'fixed', amount: p.share.amount }));
}

/** Applies a split template to a signed transaction amount. Parts sum exactly to the amount. */
export function applySplitTemplate(
  amount: { amount: string; currency: string },
  template: SplitTemplate,
  defaultOwner: string | null,
): { ok: true; splits: SplitLine[] } | { ok: false; reason: string } {
  const problems = validateSplitTemplate(template);
  if (problems.length > 0) return { ok: false, reason: problems.join('; ') };
  try {
    const parts = splitAmount(money(amount.amount, amount.currency), toShares(template));
    return {
      ok: true,
      splits: parts.map((part, index) => {
        const source = template.parts[index]!;
        return {
          amount: part.amount,
          categoryId: source.categoryId,
          nature: source.nature,
          economicOwnerEntityId: source.economicOwnerEntityId ?? defaultOwner,
          memo: source.memo,
        };
      }),
    };
  } catch (error) {
    if (error instanceof SplitError) return { ok: false, reason: error.message };
    throw error;
  }
}

/** Classifies one transaction against a rule set. Pure and deterministic. */
export function classifyTransaction(tx: ClassifiableTransaction, rules: readonly ClassificationRule[], options: ClassifyOptions = {}): ClassificationOutcome {
  const threshold = options.reviewThreshold ?? 'high';
  const explanation: ClassificationExplanationLine[] = [];
  const reviewReasons: string[] = [];
  const matched: ClassificationRule[] = [];

  for (const rule of orderRules(rules)) {
    if (!rule.enabled) continue;
    const problems = validateRule(rule);
    if (problems.length > 0) {
      if (rule.conditions.length > 0 && ruleMatches(rule, tx)) {
        explanation.push({ field: 'rule', ruleId: rule.id, ruleName: rule.name, detail: `Skipped invalid rule: ${problems.join('; ')}` });
      }
      continue;
    }
    if (ruleMatches(rule, tx)) {
      matched.push(rule);
      explanation.push({ field: 'rule', ruleId: rule.id, ruleName: rule.name, detail: `Matched: ${describeConditions(rule)} (${rule.confidence} confidence)` });
    }
  }

  const first = <K extends keyof RuleActions>(key: K, pool: readonly ClassificationRule[] = matched) =>
    pool.find((r) => r.actions[key] !== undefined) ?? null;

  // Owner
  let owner: string | null = null;
  let ownerSource: OwnerSource = 'unknown';
  let ownerConfidence: Confidence = 'none';
  const ownershipRules = matched.filter((r) => r.kind === 'ownership');
  const ownershipRule = ownershipRules[0] ?? null;
  const generalOwnerRule = first('economicOwnerEntityId', matched.filter((r) => r.kind === 'general'));
  if (ownershipRule) {
    owner = ownershipRule.actions.economicOwnerEntityId!;
    ownerSource = 'ownership_rule';
    ownerConfidence = ownershipRule.confidence;
    explanation.push({ field: 'owner', ruleId: ownershipRule.id, ruleName: ownershipRule.name, detail: 'Economic owner set by ownership rule (takes precedence)' });
    const conflicting = ownershipRules.find((r) => r.priority === ownershipRule.priority && r.actions.economicOwnerEntityId !== owner);
    if (conflicting) {
      reviewReasons.push(`Ownership rules ${ownershipRule.id} and ${conflicting.id} disagree at the same priority`);
      ownerConfidence = 'low';
    }
    if (generalOwnerRule && generalOwnerRule.actions.economicOwnerEntityId !== owner) {
      explanation.push({ field: 'owner', ruleId: generalOwnerRule.id, ruleName: generalOwnerRule.name, detail: 'Owner from general rule overridden by ownership rule' });
    }
  } else if (generalOwnerRule) {
    owner = generalOwnerRule.actions.economicOwnerEntityId!;
    ownerSource = 'rule';
    ownerConfidence = generalOwnerRule.confidence;
    explanation.push({ field: 'owner', ruleId: generalOwnerRule.id, ruleName: generalOwnerRule.name, detail: 'Economic owner set by rule' });
  } else {
    const account = options.accounts?.find((a) => a.accountId === tx.accountId) ?? null;
    if (account?.economicOwnerEntityId && account.confirmed) {
      owner = account.economicOwnerEntityId;
      ownerSource = 'account';
      ownerConfidence = 'high';
      explanation.push({ field: 'owner', ruleId: null, ruleName: null, detail: "Economic owner taken from the account's confirmed ownership" });
    } else if (account?.economicOwnerEntityId) {
      explanation.push({ field: 'owner', ruleId: null, ruleName: null, detail: 'Account ownership is recorded but unconfirmed, so it is not applied' });
    }
  }
  if (owner === null) reviewReasons.push('Economic owner is unknown');

  // Nature and category
  const natureRule = first('nature');
  const nature: TransactionNature = natureRule?.actions.nature ?? 'unknown';
  if (natureRule) explanation.push({ field: 'nature', ruleId: natureRule.id, ruleName: natureRule.name, detail: `Nature set to ${nature}` });
  else reviewReasons.push('No rule set the nature');

  const categoryRule = first('categoryId');
  const categoryId = categoryRule?.actions.categoryId ?? null;
  if (categoryRule) explanation.push({ field: 'category', ruleId: categoryRule.id, ruleName: categoryRule.name, detail: `Category set to ${categoryId ?? 'none'}` });

  // Split
  let splits: SplitLine[] | null = null;
  const splitRule = first('split');
  if (splitRule) {
    const applied = applySplitTemplate(tx.amount, splitRule.actions.split!, owner);
    if (applied.ok) {
      splits = applied.splits;
      explanation.push({ field: 'split', ruleId: splitRule.id, ruleName: splitRule.name, detail: `Split into ${splits.length} parts` });
      if (splits.some((s) => s.economicOwnerEntityId === null)) reviewReasons.push('A split part has no economic owner');
    } else {
      reviewReasons.push(`Split template could not be applied: ${applied.reason}`);
      explanation.push({ field: 'split', ruleId: splitRule.id, ruleName: splitRule.name, detail: `Split not applied: ${applied.reason}` });
    }
  }

  // Tags
  const tags: string[] = [];
  for (const rule of matched) {
    for (const tag of rule.actions.tags ?? []) {
      const t = tag.trim();
      if (t && !tags.includes(t)) tags.push(t);
    }
  }
  if (tags.length > 0) explanation.push({ field: 'tags', ruleId: null, ruleName: null, detail: `Tags: ${tags.join(', ')}` });

  // Confidence and review
  const contributing: Confidence[] = [];
  if (natureRule) contributing.push(natureRule.confidence);
  if (categoryRule) contributing.push(categoryRule.confidence);
  if (splitRule) contributing.push(splitRule.confidence);
  contributing.push(ownerConfidence);
  const confidence = natureRule ? minConfidence(contributing) : 'none';
  if (confidenceRank(confidence) < confidenceRank(threshold)) {
    reviewReasons.push(`Confidence ${confidence} is below the ${threshold} review threshold`);
  }
  const uniqueReasons = [...new Set(reviewReasons)];
  for (const reason of uniqueReasons) explanation.push({ field: 'review', ruleId: null, ruleName: null, detail: reason });

  return {
    transactionId: tx.id,
    method: matched.length > 0 ? 'rule' : 'none',
    categoryId,
    nature,
    economicOwnerEntityId: owner,
    ownerSource,
    splits,
    tags,
    confidence,
    needsReview: uniqueReasons.length > 0,
    reviewReasons: uniqueReasons,
    matchedRuleIds: matched.map((r) => r.id),
    explanation,
  };
}

export function classifyTransactions(
  transactions: readonly ClassifiableTransaction[],
  rules: readonly ClassificationRule[],
  options: ClassifyOptions = {},
): ClassificationOutcome[] {
  const ordered = orderRules(rules);
  return transactions.map((tx) => classifyTransaction(tx, ordered, options));
}

// ---------------------------------------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------------------------------------

export type ClassificationMethod = 'rule' | 'user' | 'model' | 'provider' | 'transfer_match' | 'bootstrap' | 'none';

export interface ClassificationContent {
  method: ClassificationMethod;
  categoryId: string | null;
  nature: TransactionNature;
  economicOwnerEntityId: string | null;
  splits: readonly SplitLine[] | null;
  tags: readonly string[];
  confidence: Confidence;
  needsReview: boolean;
  explanation: readonly string[];
  ruleIds: readonly string[];
  note: string | null;
}

export interface ClassificationVersion extends ClassificationContent {
  readonly sourceRecordId: string;
  readonly version: number;
  readonly current: boolean;
  readonly createdAt: IsoDateTime;
  readonly supersedesVersion: number | null;
  readonly supersededAt: IsoDateTime | null;
}

export type NextVersionResult =
  | { applied: true; previous: ClassificationVersion | null; next: ClassificationVersion }
  | { applied: false; previous: ClassificationVersion | null; reason: 'unchanged' | 'protected_user_decision' };

export function contentFromOutcome(outcome: ClassificationOutcome, note: string | null = null): ClassificationContent {
  return {
    method: outcome.method,
    categoryId: outcome.categoryId,
    nature: outcome.nature,
    economicOwnerEntityId: outcome.economicOwnerEntityId,
    splits: outcome.splits,
    tags: outcome.tags,
    confidence: outcome.confidence,
    needsReview: outcome.needsReview,
    explanation: outcome.explanation.map((e) => (e.ruleId ? `[${e.ruleId}] ${e.detail}` : e.detail)),
    ruleIds: outcome.matchedRuleIds,
    note,
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function sameContent(a: ClassificationContent, b: ClassificationContent): boolean {
  const pick = (c: ClassificationContent) =>
    JSON.stringify([c.method, c.categoryId, c.nature, c.economicOwnerEntityId, c.splits, [...c.tags].sort(), c.confidence, c.needsReview]);
  return pick(a) === pick(b);
}

export class ClassificationVersionError extends Error {
  override name = 'ClassificationVersionError';
}

/**
 * Produces the next classification version without mutating the previous one.
 * - An automatic method (anything except `user`) never overwrites an owner decision unless `overrideUser`.
 * - A `model` change can never set or change the economic owner: the previous owner is kept, and an unknown
 *   owner forces review.
 * - Identical content is not re-versioned.
 */
export function nextClassificationVersion(
  previous: ClassificationVersion | null,
  sourceRecordId: string,
  change: ClassificationContent,
  options: { at: IsoDateTime; overrideUser?: boolean },
): NextVersionResult {
  if (previous) {
    if (previous.sourceRecordId !== sourceRecordId) {
      throw new ClassificationVersionError(`Version belongs to ${previous.sourceRecordId}, not ${sourceRecordId}`);
    }
    if (!previous.current) throw new ClassificationVersionError('Only the current version can be superseded');
  }
  let content: ClassificationContent = { ...change, tags: [...change.tags], explanation: [...change.explanation], ruleIds: [...change.ruleIds] };
  if (content.method === 'model') {
    const keptOwner = previous?.economicOwnerEntityId ?? null;
    if (content.economicOwnerEntityId !== keptOwner) {
      content = {
        ...content,
        economicOwnerEntityId: keptOwner,
        explanation: [...content.explanation, 'Model output cannot decide ownership; the previous owner was kept'],
      };
    }
    if (keptOwner === null) content = { ...content, needsReview: true };
  }
  if (previous && previous.method === 'user' && content.method !== 'user' && !options.overrideUser) {
    return { applied: false, previous, reason: 'protected_user_decision' };
  }
  if (previous && sameContent(previous, content)) return { applied: false, previous, reason: 'unchanged' };

  const next: ClassificationVersion = freeze({
    ...content,
    splits: content.splits ? content.splits.map((s) => ({ ...s })) : null,
    sourceRecordId,
    version: (previous?.version ?? 0) + 1,
    current: true,
    createdAt: options.at,
    supersedesVersion: previous?.version ?? null,
    supersededAt: null,
  });
  const superseded = previous
    ? freeze({
        ...previous,
        splits: previous.splits ? previous.splits.map((s) => ({ ...s })) : null,
        tags: [...previous.tags],
        explanation: [...previous.explanation],
        ruleIds: [...previous.ruleIds],
        current: false,
        supersededAt: options.at,
      })
    : null;
  return { applied: true, previous: superseded, next };
}
