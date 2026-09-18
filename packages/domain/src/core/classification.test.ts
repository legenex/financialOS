import { describe, expect, it } from 'vitest';
import { dec, money } from '../money';
import {
  applySplitTemplate,
  classifyTransaction,
  classifyTransactions,
  ClassificationVersionError,
  contentFromOutcome,
  hasIdentityCondition,
  minConfidence,
  nextClassificationVersion,
  normaliseText,
  orderRules,
  validateRule,
  type ClassifiableTransaction,
  type ClassificationContent,
  type ClassificationRule,
} from './classification';

const OWNER = 'ent-owner';
const COMPANY = 'ent-company';
const THIRD = 'ent-third-party-a';

function tx(over: Partial<ClassifiableTransaction> = {}): ClassifiableTransaction {
  return {
    id: 'tx-1',
    accountId: 'acc-company-usd',
    bookedOn: '2026-05-04',
    amount: money('-42.50', 'USD'),
    description: 'CARD PURCHASE   Example   Coffee Roasters',
    counterparty: 'Example Coffee Roasters Ltd',
    cardLast4: '4821',
    ...over,
  };
}

function rule(over: Partial<ClassificationRule> & Pick<ClassificationRule, 'id'>): ClassificationRule {
  return {
    name: `Rule ${over.id}`,
    enabled: true,
    priority: 10,
    kind: 'general',
    conditions: [{ kind: 'description', op: 'contains', value: 'coffee' }],
    actions: {},
    confidence: 'high',
    ...over,
  };
}

const coffee = rule({ id: 'r-coffee', actions: { categoryId: 'cat-coffee', nature: 'consumption', tags: ['coffee'] } });

describe('matching', () => {
  it('normalises case and whitespace', () => {
    expect(normaliseText('  CARD\tPURCHASE \n Example  ')).toBe('card purchase example');
    const outcome = classifyTransaction(tx(), [rule({ id: 'r1', conditions: [{ kind: 'description', op: 'contains', value: 'purchase example   COFFEE' }], actions: { nature: 'consumption' } })]);
    expect(outcome.matchedRuleIds).toEqual(['r1']);
  });

  it('supports startsWith and equals', () => {
    const t = tx();
    expect(classifyTransaction(t, [rule({ id: 'a', conditions: [{ kind: 'description', op: 'startsWith', value: 'card purchase' }], actions: { nature: 'consumption' } })]).matchedRuleIds).toEqual(['a']);
    expect(classifyTransaction(t, [rule({ id: 'b', conditions: [{ kind: 'description', op: 'startsWith', value: 'coffee' }], actions: { nature: 'consumption' } })]).matchedRuleIds).toEqual([]);
    expect(classifyTransaction(t, [rule({ id: 'c', conditions: [{ kind: 'description', op: 'equals', value: 'card purchase example coffee roasters' }], actions: { nature: 'consumption' } })]).matchedRuleIds).toEqual(['c']);
    expect(classifyTransaction(t, [rule({ id: 'd', conditions: [{ kind: 'description', op: 'equals', value: 'card purchase' }], actions: { nature: 'consumption' } })]).matchedRuleIds).toEqual([]);
  });

  it('treats pattern-like text literally (no regular expressions)', () => {
    const literal = rule({ id: 'lit', conditions: [{ kind: 'description', op: 'contains', value: 'a+(b|c)*' }], actions: { nature: 'consumption' } });
    expect(classifyTransaction(tx({ description: 'Shop a+(b|c)* branch' }), [literal]).matchedRuleIds).toEqual(['lit']);
    expect(classifyTransaction(tx({ description: 'Shop aaab branch' }), [literal]).matchedRuleIds).toEqual([]);
    // A classic catastrophic-backtracking input is handled in linear time.
    const evil = rule({ id: 'evil', conditions: [{ kind: 'description', op: 'contains', value: '(a+)+$' }], actions: { nature: 'consumption' } });
    const started = Date.now();
    classifyTransaction(tx({ description: `${'a'.repeat(50_000)}!` }), [evil]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('matches amount ranges inclusively on the magnitude, direction, currency, account, counterparty and card', () => {
    const t = tx();
    const matches = (conditions: ClassificationRule['conditions']) => classifyTransaction(t, [rule({ id: 'm', conditions, actions: { nature: 'consumption' } })]).matchedRuleIds.length === 1;
    expect(matches([{ kind: 'amount_range', min: '42.50', max: '42.50' }])).toBe(true);
    expect(matches([{ kind: 'amount_range', min: '42.51', max: null }])).toBe(false);
    expect(matches([{ kind: 'amount_range', min: null, max: '42.49' }])).toBe(false);
    expect(matches([{ kind: 'direction', value: 'out' }])).toBe(true);
    expect(matches([{ kind: 'direction', value: 'in' }])).toBe(false);
    expect(matches([{ kind: 'currency', value: 'USD' }])).toBe(true);
    expect(matches([{ kind: 'currency', value: 'EUR' }])).toBe(false);
    expect(matches([{ kind: 'account', accountIds: ['acc-other', 'acc-company-usd'] }])).toBe(true);
    expect(matches([{ kind: 'account', accountIds: ['acc-other'] }])).toBe(false);
    expect(matches([{ kind: 'counterparty', op: 'contains', value: 'coffee roasters' }])).toBe(true);
    expect(matches([{ kind: 'counterparty', op: 'equals', value: 'coffee roasters' }])).toBe(false);
    expect(matches([{ kind: 'card_last4', value: '4821' }])).toBe(true);
    expect(matches([{ kind: 'card_last4', value: '0000' }])).toBe(false);
    // All conditions must hold.
    expect(matches([{ kind: 'card_last4', value: '4821' }, { kind: 'currency', value: 'EUR' }])).toBe(false);
    expect(classifyTransaction(tx({ counterparty: null }), [rule({ id: 'n', conditions: [{ kind: 'counterparty', op: 'contains', value: 'x' }], actions: { nature: 'consumption' } })]).matchedRuleIds).toEqual([]);
    expect(classifyTransaction(tx({ cardLast4: undefined }), [rule({ id: 'n', conditions: [{ kind: 'card_last4', value: '4821' }], actions: { nature: 'consumption' } })]).matchedRuleIds).toEqual([]);
  });
});

describe('rule validation', () => {
  it('rejects rules that would infer ownership from currency, amount or direction alone', () => {
    const byCurrency = rule({ id: 'cur', conditions: [{ kind: 'currency', value: 'USD' }, { kind: 'direction', value: 'in' }], actions: { economicOwnerEntityId: THIRD } });
    expect(hasIdentityCondition(byCurrency)).toBe(false);
    expect(validateRule(byCurrency).join(' ')).toMatch(/never inferred from currency/);
    expect(validateRule(rule({ id: 'ok', conditions: [{ kind: 'account', accountIds: ['acc-1'] }, { kind: 'currency', value: 'USD' }], actions: { economicOwnerEntityId: THIRD } }))).toEqual([]);
  });

  it('reports malformed conditions and templates', () => {
    const issues = validateRule(
      rule({
        id: 'bad',
        kind: 'ownership',
        priority: 1.5,
        conditions: [
          { kind: 'description', op: 'contains', value: '   ' },
          { kind: 'amount_range', min: '10', max: '5' },
          { kind: 'amount_range', min: null, max: null },
          { kind: 'currency', value: 'usd' },
          { kind: 'card_last4', value: '12' },
          { kind: 'account', accountIds: [] },
        ],
        actions: { split: { parts: [{ share: { kind: 'percent', percent: '90' }, categoryId: null, nature: 'consumption', economicOwnerEntityId: null, memo: null }] } },
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'Rule priority must be an integer',
        'Condition 1: text must not be empty',
        'Condition 2: min is greater than max',
        'Condition 3: an amount range needs a bound',
        'Condition 4: invalid currency code',
        'Condition 5: card last-4 must be four digits',
        'Condition 6: account list must not be empty',
        'An ownership rule must set an economic owner',
        'Split percentages must sum to exactly 100',
      ]),
    );
    expect(validateRule(rule({ id: 'empty', conditions: [] }))).toContain('A rule needs at least one condition');
  });

  it('skips invalid rules with an explanation', () => {
    const outcome = classifyTransaction(tx(), [rule({ id: 'cur', conditions: [{ kind: 'currency', value: 'USD' }], actions: { economicOwnerEntityId: THIRD, nature: 'third_party' } })]);
    expect(outcome.economicOwnerEntityId).toBeNull();
    expect(outcome.matchedRuleIds).toEqual([]);
    expect(outcome.explanation.some((e) => e.ruleId === 'cur' && /Skipped invalid rule/.test(e.detail))).toBe(true);
    expect(outcome.needsReview).toBe(true);
  });
});

describe('classifyTransaction', () => {
  it('evaluates rules in a deterministic priority order', () => {
    const low = rule({ id: 'a-low', priority: 1, actions: { categoryId: 'cat-low', nature: 'consumption', tags: ['low'] } });
    const high = rule({ id: 'z-high', priority: 50, actions: { categoryId: 'cat-high', tags: ['high'] } });
    const tieA = rule({ id: 'm-tie', priority: 50, actions: { categoryId: 'cat-tie', tags: ['tie', 'high'] } });
    expect(orderRules([low, high, tieA]).map((r) => r.id)).toEqual(['m-tie', 'z-high', 'a-low']);
    const outcome = classifyTransaction(tx(), [low, high, tieA], { accounts: [{ accountId: 'acc-company-usd', economicOwnerEntityId: COMPANY, confirmed: true }] });
    expect(outcome.categoryId).toBe('cat-tie');
    expect(outcome.nature).toBe('consumption');
    expect(outcome.tags).toEqual(['tie', 'high', 'low']);
    expect(outcome.matchedRuleIds).toEqual(['m-tie', 'z-high', 'a-low']);
    // Same result regardless of input order.
    expect(classifyTransaction(tx(), [tieA, low, high], { accounts: [{ accountId: 'acc-company-usd', economicOwnerEntityId: COMPANY, confirmed: true }] })).toEqual(outcome);
  });

  it('gives card and ownership rules precedence for the economic owner', () => {
    const general = rule({ id: 'g', priority: 100, conditions: [{ kind: 'description', op: 'contains', value: 'coffee' }], actions: { nature: 'consumption', economicOwnerEntityId: OWNER } });
    const card = rule({ id: 'card', kind: 'ownership', priority: 1, conditions: [{ kind: 'card_last4', value: '4821' }, { kind: 'account', accountIds: ['acc-company-usd'] }], actions: { economicOwnerEntityId: THIRD, nature: 'third_party' } });
    const outcome = classifyTransaction(tx(), [general, card], { accounts: [{ accountId: 'acc-company-usd', economicOwnerEntityId: COMPANY, confirmed: true }] });
    expect(outcome.economicOwnerEntityId).toBe(THIRD);
    expect(outcome.ownerSource).toBe('ownership_rule');
    expect(outcome.nature).toBe('consumption');
    expect(outcome.explanation.some((e) => /overridden by ownership rule/.test(e.detail))).toBe(true);
    const otherCard = classifyTransaction(tx({ cardLast4: '9999' }), [general, card], { accounts: [{ accountId: 'acc-company-usd', economicOwnerEntityId: COMPANY, confirmed: true }] });
    expect(otherCard.economicOwnerEntityId).toBe(OWNER);
    expect(otherCard.ownerSource).toBe('rule');
  });

  it('uses only confirmed account ownership and never the currency', () => {
    const confirmed = classifyTransaction(tx(), [coffee], { accounts: [{ accountId: 'acc-company-usd', economicOwnerEntityId: COMPANY, confirmed: true }] });
    expect(confirmed).toMatchObject({ economicOwnerEntityId: COMPANY, ownerSource: 'account', confidence: 'high', needsReview: false });
    const unconfirmed = classifyTransaction(tx(), [coffee], { accounts: [{ accountId: 'acc-company-usd', economicOwnerEntityId: COMPANY, confirmed: false }] });
    expect(unconfirmed).toMatchObject({ economicOwnerEntityId: null, ownerSource: 'unknown', confidence: 'none', needsReview: true });
    expect(unconfirmed.reviewReasons).toContain('Economic owner is unknown');
  });

  it('flags results below the confidence threshold', () => {
    const medium = rule({ id: 'med', confidence: 'medium', actions: { nature: 'consumption', categoryId: 'cat-coffee' } });
    const accounts = [{ accountId: 'acc-company-usd', economicOwnerEntityId: COMPANY, confirmed: true }];
    const flagged = classifyTransaction(tx(), [medium], { accounts });
    expect(flagged.confidence).toBe('medium');
    expect(flagged.needsReview).toBe(true);
    expect(flagged.reviewReasons).toEqual(['Confidence medium is below the high review threshold']);
    expect(classifyTransaction(tx(), [medium], { accounts, reviewThreshold: 'medium' }).needsReview).toBe(false);
    expect(minConfidence(['high', 'low', 'medium'])).toBe('low');
    expect(minConfidence([])).toBe('none');
  });

  it('flags conflicting ownership rules at the same priority', () => {
    const a = rule({ id: 'own-a', kind: 'ownership', conditions: [{ kind: 'card_last4', value: '4821' }], actions: { economicOwnerEntityId: THIRD } });
    const b = rule({ id: 'own-b', kind: 'ownership', conditions: [{ kind: 'account', accountIds: ['acc-company-usd'] }], actions: { economicOwnerEntityId: COMPANY } });
    const outcome = classifyTransaction(tx(), [coffee, a, b]);
    expect(outcome.economicOwnerEntityId).toBe(THIRD);
    expect(outcome.confidence).toBe('low');
    expect(outcome.needsReview).toBe(true);
    expect(outcome.reviewReasons[0]).toMatch(/disagree/);
  });

  it('returns an unknown, reviewable result when nothing matches', () => {
    const outcome = classifyTransaction(tx({ description: 'Unrelated' }), [coffee]);
    expect(outcome).toMatchObject({ method: 'none', nature: 'unknown', categoryId: null, confidence: 'none', needsReview: true, splits: null, tags: [] });
    expect(outcome.reviewReasons).toEqual(['Economic owner is unknown', 'No rule set the nature', 'Confidence none is below the high review threshold']);
  });

  it('applies split templates exactly, with owner fallback', () => {
    const split = rule({
      id: 'split',
      conditions: [{ kind: 'card_last4', value: '4821' }],
      actions: {
        nature: 'consumption',
        economicOwnerEntityId: OWNER,
        split: {
          parts: [
            { share: { kind: 'fixed', amount: '2.50' }, categoryId: 'cat-tip', nature: 'consumption', economicOwnerEntityId: null, memo: 'tip' },
            { share: { kind: 'percent', percent: '66.67' }, categoryId: 'cat-coffee', nature: 'consumption', economicOwnerEntityId: null, memo: null },
            { share: { kind: 'percent', percent: '33.33' }, categoryId: 'cat-coffee', nature: 'business_support', economicOwnerEntityId: COMPANY, memo: null },
          ],
        },
      },
    });
    const outcome = classifyTransaction(tx({ amount: money('-42.51', 'USD') }), [split]);
    expect(outcome.splits!.map((s) => [s.amount, s.economicOwnerEntityId, s.nature])).toEqual([
      ['-2.5', OWNER, 'consumption'],
      ['-26.67', OWNER, 'consumption'],
      ['-13.34', COMPANY, 'business_support'],
    ]);
    expect(outcome.splits!.reduce((acc, s) => acc.plus(dec(s.amount)), dec('0')).toFixed()).toBe('-42.51');
    const tooBig = classifyTransaction(tx({ amount: money('-1', 'USD') }), [split]);
    expect(tooBig.splits).toBeNull();
    expect(tooBig.needsReview).toBe(true);
    expect(tooBig.reviewReasons.join(' ')).toMatch(/Split template could not be applied/);
    expect(applySplitTemplate(money('10', 'USD'), { parts: [] }, null)).toEqual({ ok: false, reason: 'A split template needs at least one part' });
    const unowned = applySplitTemplate(money('10', 'USD'), { parts: [{ share: { kind: 'percent', percent: '100' }, categoryId: null, nature: 'consumption', economicOwnerEntityId: null, memo: null }] }, null);
    expect(unowned).toEqual({ ok: true, splits: [{ amount: '10', categoryId: null, nature: 'consumption', economicOwnerEntityId: null, memo: null }] });
  });

  it('classifies a batch deterministically', () => {
    const out = classifyTransactions([tx({ id: 'a' }), tx({ id: 'b', description: 'other' })], [coffee]);
    expect(out.map((o) => [o.transactionId, o.method])).toEqual([
      ['a', 'rule'],
      ['b', 'none'],
    ]);
  });
});

describe('classification versions', () => {
  const content = (over: Partial<ClassificationContent> = {}): ClassificationContent => ({
    method: 'rule',
    categoryId: 'cat-coffee',
    nature: 'consumption',
    economicOwnerEntityId: OWNER,
    splits: null,
    tags: ['coffee'],
    confidence: 'high',
    needsReview: false,
    explanation: ['matched'],
    ruleIds: ['r-coffee'],
    note: null,
    ...over,
  });

  it('creates versions without mutating the previous one', () => {
    const first = nextClassificationVersion(null, 'src-1', content(), { at: '2026-05-04T10:00:00Z' });
    if (!first.applied) throw new Error('expected applied');
    expect(first.next).toMatchObject({ version: 1, current: true, supersedesVersion: null, supersededAt: null });
    expect(Object.isFrozen(first.next)).toBe(true);
    const second = nextClassificationVersion(first.next, 'src-1', content({ method: 'user', categoryId: 'cat-dining' }), { at: '2026-05-05T10:00:00Z' });
    if (!second.applied) throw new Error('expected applied');
    expect(second.next).toMatchObject({ version: 2, current: true, supersedesVersion: 1, categoryId: 'cat-dining' });
    expect(second.previous).toMatchObject({ version: 1, current: false, supersededAt: '2026-05-05T10:00:00Z' });
    expect(first.next.current).toBe(true);
    expect(() => nextClassificationVersion(second.previous, 'src-1', content(), { at: '2026-05-06T10:00:00Z' })).toThrow(ClassificationVersionError);
    expect(() => nextClassificationVersion(second.next, 'src-2', content(), { at: '2026-05-06T10:00:00Z' })).toThrow(/belongs to/);
  });

  it('protects owner decisions from automatic re-classification', () => {
    const user = nextClassificationVersion(null, 'src-1', content({ method: 'user' }), { at: '2026-05-04T10:00:00Z' });
    if (!user.applied) throw new Error('expected applied');
    const rerun = nextClassificationVersion(user.next, 'src-1', content({ categoryId: 'cat-other' }), { at: '2026-05-05T10:00:00Z' });
    expect(rerun).toEqual({ applied: false, previous: user.next, reason: 'protected_user_decision' });
    const forced = nextClassificationVersion(user.next, 'src-1', content({ categoryId: 'cat-other' }), { at: '2026-05-05T10:00:00Z', overrideUser: true });
    expect(forced.applied).toBe(true);
  });

  it('skips unchanged content', () => {
    const first = nextClassificationVersion(null, 'src-1', content(), { at: '2026-05-04T10:00:00Z' });
    if (!first.applied) throw new Error('expected applied');
    expect(nextClassificationVersion(first.next, 'src-1', content({ tags: ['coffee'], explanation: ['different wording'] }), { at: '2026-05-05T10:00:00Z' })).toMatchObject({
      applied: false,
      reason: 'unchanged',
    });
  });

  it('never lets model output decide ownership', () => {
    const first = nextClassificationVersion(null, 'src-1', content({ method: 'model', economicOwnerEntityId: THIRD, needsReview: false }), { at: '2026-05-04T10:00:00Z' });
    if (!first.applied) throw new Error('expected applied');
    expect(first.next.economicOwnerEntityId).toBeNull();
    expect(first.next.needsReview).toBe(true);
    expect(first.next.explanation).toContain('Model output cannot decide ownership; the previous owner was kept');
    const owned = nextClassificationVersion(null, 'src-2', content({ method: 'rule' }), { at: '2026-05-04T10:00:00Z' });
    if (!owned.applied) throw new Error('expected applied');
    const model = nextClassificationVersion(owned.next, 'src-2', content({ method: 'model', economicOwnerEntityId: COMPANY, categoryId: 'cat-x' }), { at: '2026-05-05T10:00:00Z' });
    if (!model.applied) throw new Error('expected applied');
    expect(model.next.economicOwnerEntityId).toBe(OWNER);
  });

  it('converts an outcome into version content', () => {
    const outcome = classifyTransaction(tx(), [coffee], { accounts: [{ accountId: 'acc-company-usd', economicOwnerEntityId: COMPANY, confirmed: true }] });
    const c = contentFromOutcome(outcome, 'auto');
    expect(c).toMatchObject({ method: 'rule', categoryId: 'cat-coffee', economicOwnerEntityId: COMPANY, ruleIds: ['r-coffee'], note: 'auto' });
    expect(c.explanation[0]).toMatch(/^\[r-coffee\] Matched/);
  });
});
