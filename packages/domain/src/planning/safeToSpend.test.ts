import { SafeToSpendResult } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { recurringOccurrenceId } from './cashflow';
import { computeSafeToSpend, reservesFromGoals, safeToSpend, type SafeToSpendInput } from './safeToSpend';
import { account, COMPANY_ID, ENTITIES, NOW, OWNER_ID, recurring, THIRD_PARTY_ID, TODAY, uid, usd, zar } from './testing';

const EVERYDAY = uid(100);
const SAVINGS = uid(101);
const BUSINESS = uid(102);
const CLIENT_FUNDS = uid(103);
const BROKERAGE = uid(104);
const CARD = uid(105);
const USD_ACCOUNT = uid(106);
const RESERVE_ACCOUNT = uid(107);
const RENT = uid(200);
const SALARY = uid(201);

const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18.5', asOf: '2026-03-09', source: 'test-rates' }]);

function baseInput(overrides: Partial<SafeToSpendInput> = {}): SafeToSpendInput {
  return {
    now: NOW,
    today: TODAY,
    primaryOwnerEntityId: OWNER_ID,
    entities: ENTITIES,
    accounts: [account({ id: EVERYDAY, name: 'Everyday account', balance: zar('10000') })],
    recurring: [recurring({ id: RENT, name: 'Rent', nextDueOn: '2026-03-25', amount: { amount: '4000', currency: 'ZAR' } })],
    obligations: [],
    reserves: [],
    settings: { budgetCurrency: 'ZAR', horizonDays: 30, horizonBasis: 'fixed_days', includeNearCash: false, staleAfterHours: 48 },
    fx,
    ...overrides,
  };
}

function amountOf(result: SafeToSpendResult): string | null {
  return result.amount?.amount ?? null;
}

describe('safeToSpend: basics', () => {
  it('subtracts dated obligations from eligible cash and returns a valid contract object', () => {
    const result = safeToSpend(baseInput());
    expect(() => SafeToSpendResult.parse(result)).not.toThrow();
    expect(result.status).toBe('ok');
    expect(result.confidence).toBe('high');
    expect(result.eligibleCash).toEqual(zar('10000'));
    expect(result.obligationsInHorizon).toEqual(zar('4000'));
    expect(result.lowestProjectedBalance).toEqual(zar('6000'));
    expect(result.lowestProjectedOn).toBe('2026-03-25');
    expect(amountOf(result)).toBe('6000');
    expect(result.shortfall).toBeNull();
    expect(result.horizon).toEqual({ from: TODAY, to: '2026-04-09', days: 30, basis: 'Fixed 30 days' });
    expect(result.computedAt).toBe(NOW);
    const rentLine = result.explanation.items.find((i) => i.label === 'Rent on 2026-03-25');
    expect(rentLine).toEqual(expect.objectContaining({ role: 'subtracted', value: zar('4000') }));
    expect(rentLine?.links).toContainEqual({ kind: 'recurring', id: RENT, label: 'Rent' });
    expect(result.explanation.formula).toContain('protected reserves');
  });

  it('uses the lowest point, not the closing balance, when income arrives later', () => {
    const result = safeToSpend(
      baseInput({
        recurring: [
          recurring({ id: RENT, name: 'Rent', nextDueOn: '2026-03-25', amount: { amount: '9000', currency: 'ZAR' } }),
          recurring({ id: SALARY, name: 'Salary', direction: 'in', kind: 'salary', nextDueOn: '2026-03-26', amount: { amount: '30000', currency: 'ZAR' } }),
        ],
      }),
    );
    expect(result.expectedInflowsInHorizon).toEqual(zar('30000'));
    expect(result.lowestProjectedBalance).toEqual(zar('1000'));
    expect(amountOf(result)).toBe('1000');
  });

  it('reports a shortfall when obligations and reserves exceed eligible cash', () => {
    const result = safeToSpend(
      baseInput({
        reserves: [{ id: uid(300), name: 'Emergency reserve', heldIn: 'eligible_cash_accounts', amount: zar('7000'), basis: 'reserve target' }],
      }),
    );
    expect(amountOf(result)).toBe('0');
    expect(result.shortfall).toEqual(zar('1000'));
    expect(result.explanation.items).toContainEqual(expect.objectContaining({ label: 'Shortfall', value: zar('1000'), role: 'result' }));
  });
});

describe('safeToSpend: reserves', () => {
  it('subtracts a reserve held in the eligible account exactly once', () => {
    const reserve = { id: uid(300), name: 'Emergency reserve', heldIn: 'eligible_cash_accounts' as const, amount: zar('2500'), basis: 'reserve target' };
    const result = safeToSpend(baseInput({ reserves: [reserve] }));
    expect(result.protectedReserves).toEqual(zar('2500'));
    // 10000 − 4000 rent = 6000 lowest; 6000 − 2500 = 3500.
    expect(result.lowestProjectedBalance).toEqual(zar('6000'));
    expect(amountOf(result)).toBe('3500');
    const reserveLines = result.explanation.items.filter((i) => i.label === 'Protected reserve: Emergency reserve');
    expect(reserveLines).toHaveLength(1);
    expect(reserveLines[0]?.role).toBe('subtracted');
    // The timeline is the cash projection: the reserve never appears as a dated outflow.
    expect(result.timeline.filter((t) => t.label.includes('reserve'))).toEqual([]);
  });

  it('does not subtract a reserve held in a separate account at all', () => {
    const reserve = { id: uid(301), name: 'Holiday fund', heldIn: 'separate_accounts' as const, amount: zar('2500'), basis: 'verified amount set aside' };
    const result = safeToSpend(
      baseInput({
        accounts: [
          account({ id: EVERYDAY, name: 'Everyday account', balance: zar('10000') }),
          account({ id: RESERVE_ACCOUNT, name: 'Holiday savings', kind: 'savings', balance: zar('2500'), includeInSafeToSpend: false }),
        ],
        reserves: [reserve],
      }),
    );
    expect(result.protectedReserves).toEqual(zar('0'));
    expect(amountOf(result)).toBe('6000');
    expect(result.explanation.items).toContainEqual(
      expect.objectContaining({ label: 'Protected reserve: Holiday fund', role: 'excluded', note: 'Already outside eligible cash' }),
    );
    expect(result.explanation.items).toContainEqual(expect.objectContaining({ label: 'Holiday savings', role: 'excluded', note: 'Excluded from safe-to-spend by the owner' }));
  });

  it('marks an unknown reserve amount as provisional', () => {
    const result = safeToSpend(baseInput({ reserves: [{ id: uid(302), name: 'Reserve', heldIn: 'eligible_cash_accounts', amount: null, basis: 'reserve target' }] }));
    expect(result.status).toBe('provisional');
    expect(result.explanation.missing).toContain('Protected reserve Reserve: amount unknown');
  });

  it('derives reserves from goals', () => {
    const goal = { protected: true, status: 'active' as const, heldIn: 'eligible_cash_accounts' as const };
    const reserves = reservesFromGoals([
      { ...goal, id: uid(310), name: 'Emergency', kind: 'emergency_reserve', target: zar('5000'), fundedVerified: zar('1000') },
      { ...goal, id: uid(311), name: 'Trip', kind: 'travel', target: zar('3000'), fundedVerified: zar('1200') },
      { ...goal, id: uid(312), name: 'Overfunded', kind: 'sinking_fund', target: zar('100'), fundedVerified: zar('150') },
      { ...goal, id: uid(313), name: 'Archived', kind: 'reserve', target: zar('100'), fundedVerified: zar('0'), status: 'archived' },
      { ...goal, id: uid(314), name: 'Unprotected', kind: 'reserve', target: zar('100'), fundedVerified: zar('0'), protected: false },
    ]);
    expect(reserves.map((r) => [r.name, r.amount?.amount, r.basis])).toEqual([
      ['Emergency', '5000', 'reserve target'],
      ['Trip', '1200', 'verified amount set aside'],
      ['Overfunded', '100', 'verified amount set aside'],
    ]);
  });
});

describe('safeToSpend: no double counting', () => {
  it('counts an obligation that appears both as recurring and as a one-off with the same id once', () => {
    const occurrence = recurringOccurrenceId(RENT, '2026-03-25');
    const result = computeSafeToSpend(
      baseInput({
        obligations: [
          { id: uid(400), entityId: OWNER_ID, dueOn: '2026-03-25', amount: { amount: '4200', currency: 'ZAR' }, label: 'Rent (adjusted)', kind: 'bill', status: 'upcoming', recurringItemId: RENT },
        ],
        extraFlows: [
          { id: occurrence, date: '2026-03-25', label: 'Rent (copy)', direction: 'out', amount: zar('4000'), certainty: 'committed', source: 'other', links: [] },
        ],
      }),
    );
    expect(computeSafeToSpend(baseInput()).result.obligationsInHorizon).toEqual(zar('4000'));
    expect(result.result.obligationsInHorizon).toEqual(zar('4200'));
    expect(result.projection?.applied.filter((a) => a.id === occurrence)).toHaveLength(1);
    expect(result.projection?.skipped.filter((s) => s.reason === 'duplicate')).toHaveLength(2);
    expect(amountOf(result.result)).toBe('5800');
  });

  it('counts a plain duplicate id once', () => {
    const obligation = { id: uid(401), entityId: OWNER_ID, dueOn: '2026-03-20', amount: { amount: '300', currency: 'ZAR' }, label: 'Licence', kind: 'bill' as const, status: 'upcoming' as const };
    const result = safeToSpend(
      baseInput({
        obligations: [obligation],
        extraFlows: [{ id: uid(401), date: '2026-03-20', label: 'Licence', direction: 'out', amount: zar('300'), certainty: 'committed', source: 'recurring', links: [] }],
      }),
    );
    expect(result.obligationsInHorizon).toEqual(zar('4300'));
  });

  it('counts committed goal contributions once and ignores plans that are not commitments', () => {
    const result = safeToSpend(
      baseInput({
        goalContributions: [
          { id: 'c1', goalId: uid(500), goalName: 'Holiday', date: '2026-03-28', amount: zar('1000'), commitment: true },
          { id: 'c2', goalId: uid(500), goalName: 'Holiday', date: '2026-03-29', amount: zar('1000'), commitment: false },
        ],
      }),
    );
    expect(result.obligationsInHorizon).toEqual(zar('5000'));
  });
});

describe('safeToSpend: ownership and liquidity exclusions', () => {
  const accounts = [
    account({ id: EVERYDAY, name: 'Everyday account', balance: zar('10000') }),
    account({ id: BUSINESS, name: 'Example Holdings operating', legalEntityId: COMPANY_ID, economicOwnerEntityId: COMPANY_ID, balance: zar('900000') }),
    account({ id: uid(108), name: 'Company account owner-mapped', legalEntityId: COMPANY_ID, economicOwnerEntityId: OWNER_ID, balance: zar('50000') }),
    account({ id: CLIENT_FUNDS, name: 'Held for third party', economicOwnerEntityId: THIRD_PARTY_ID, balance: zar('70000') }),
    account({ id: BROKERAGE, name: 'Brokerage', kind: 'brokerage', liquidityClass: 'marketable', balance: zar('300000') }),
    account({ id: CARD, name: 'Credit card', kind: 'credit_card', liquidityClass: 'liability', balance: zar('-2000'), creditLimit: zar('50000') }),
    account({ id: uid(109), name: 'Share scheme', kind: 'restricted_equity', liquidityClass: 'restricted', balance: zar('999999') }),
    account({ id: uid(110), name: 'Unmapped account', economicOwnerEntityId: null, balance: zar('1234') }),
    account({ id: uid(111), name: 'Notice deposit', kind: 'savings', liquidityClass: 'near_cash', balance: zar('5000') }),
    account({ id: uid(112), name: 'Closed account', status: 'closed', balance: zar('1') }),
  ];

  it('never counts business cash, and explains every exclusion', () => {
    const computation = computeSafeToSpend(baseInput({ accounts }));
    const result = computation.result;
    expect(result.eligibleCash).toEqual(zar('10000'));
    expect(computation.eligibleAccountIds).toEqual([EVERYDAY]);
    expect(computation.excludedAccounts).toEqual([
      { accountId: BUSINESS, reason: 'Business account: company cash is not personal spending money' },
      { accountId: uid(108), reason: 'Business account: company cash is not personal spending money' },
      { accountId: CLIENT_FUNDS, reason: 'Third-party money: belongs to someone else' },
      { accountId: BROKERAGE, reason: 'Marketable investments are not guaranteed spending cash' },
      { accountId: CARD, reason: 'Credit card: credit limits are not cash' },
      { accountId: uid(109), reason: 'Restricted asset: never part of spending capacity' },
      { accountId: uid(110), reason: 'Economic owner unconfirmed' },
      { accountId: uid(111), reason: 'Near-cash is excluded by the safe-to-spend setting' },
    ]);
    const inputs = result.explanation.items.filter((i) => i.role === 'input').map((i) => i.label);
    expect(inputs).toEqual(['Everyday account balance']);
    expect(result.explanation.items).toContainEqual(expect.objectContaining({ label: 'Credit card: credit limit', value: zar('50000'), role: 'excluded' }));
    expect(JSON.stringify(result.timeline)).not.toContain('Example Holdings');
  });

  it('includes near-cash only when the setting allows it', () => {
    const result = safeToSpend(baseInput({ accounts, settings: { ...baseInput().settings, includeNearCash: true } }));
    expect(result.eligibleCash).toEqual(zar('15000'));
  });

  it('keeps business recurring items out of personal safe-to-spend', () => {
    const result = safeToSpend(
      baseInput({
        recurring: [
          recurring({ id: RENT, name: 'Rent', nextDueOn: '2026-03-25', amount: { amount: '4000', currency: 'ZAR' } }),
          recurring({ id: uid(202), name: 'Payroll', entityId: COMPANY_ID, kind: 'payroll', nextDueOn: '2026-03-26', amount: { amount: '80000', currency: 'ZAR' } }),
        ],
      }),
    );
    expect(result.obligationsInHorizon).toEqual(zar('4000'));
    expect(result.explanation.assumptions.some((a) => a.includes('belong to other entities'))).toBe(true);
  });

  it('subtracts third-party money held inside an eligible account', () => {
    const result = safeToSpend(
      baseInput({
        thirdPartyHoldings: [{ accountId: EVERYDAY, arrangementId: uid(600), label: 'Sample Third Party balance', amount: zar('3000') }],
      }),
    );
    expect(result.eligibleCash).toEqual(zar('7000'));
    expect(amountOf(result)).toBe('3000');
    expect(result.explanation.items).toContainEqual(
      expect.objectContaining({
        label: 'Sample Third Party balance (third-party money in Everyday account)',
        role: 'subtracted',
        value: zar('3000'),
        links: [
          { kind: 'arrangement', id: uid(600), label: 'Sample Third Party balance' },
          { kind: 'account', id: EVERYDAY, label: 'Everyday account' },
        ],
      }),
    );
  });

  it('treats an unknown third-party amount as provisional', () => {
    const result = safeToSpend(baseInput({ thirdPartyHoldings: [{ accountId: EVERYDAY, arrangementId: uid(600), label: 'Arrangement', amount: null }] }));
    expect(result.status).toBe('provisional');
    expect(result.eligibleCash).toEqual(zar('10000'));
  });
});

describe('safeToSpend: data quality statuses', () => {
  it('is provisional when an obligation in the horizon has an unknown amount', () => {
    const result = safeToSpend(
      baseInput({
        obligations: [{ id: uid(700), entityId: OWNER_ID, dueOn: '2026-03-20', amount: { amount: null, currency: null }, label: 'Municipal bill', kind: 'bill', status: 'upcoming' }],
      }),
    );
    expect(result.status).toBe('provisional');
    expect(result.confidence).toBe('medium');
    expect(result.unknownAmountObligations).toBe(1);
    expect(amountOf(result)).toBe('6000');
    expect(result.explanation.missing).toContain('Municipal bill on 2026-03-20: amount unknown');
    expect(result.timeline).toContainEqual(expect.objectContaining({ kind: 'unknown_amount', label: 'Municipal bill (amount unknown, not included)' }));
  });

  it('ignores unknown-amount obligations outside the horizon', () => {
    const result = safeToSpend(
      baseInput({
        obligations: [{ id: uid(701), entityId: OWNER_ID, dueOn: '2026-06-20', amount: { amount: null, currency: null }, label: 'Later bill', kind: 'bill', status: 'upcoming' }],
      }),
    );
    expect(result.status).toBe('ok');
    expect(result.unknownAmountObligations).toBe(0);
  });

  it('is insufficient_data with a null amount when no eligible balance is known', () => {
    const result = safeToSpend(baseInput({ accounts: [account({ id: EVERYDAY, name: 'Everyday account', balance: null })] }));
    expect(result.status).toBe('insufficient_data');
    expect(result.amount).toBeNull();
    expect(result.shortfall).toBeNull();
    expect(result.eligibleCash).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.timeline).toEqual([]);
    expect(result.explanation.missing).toContain('Everyday account: balance unknown');
    expect(() => SafeToSpendResult.parse(result)).not.toThrow();
  });

  it('is insufficient_data when there are no eligible accounts at all', () => {
    const result = safeToSpend(baseInput({ accounts: [] }));
    expect(result.status).toBe('insufficient_data');
    expect(result.explanation.missing).toContain('No eligible personal cash accounts are configured');
  });

  it('is insufficient_data when every eligible balance is stale', () => {
    const result = safeToSpend(baseInput({ accounts: [account({ id: EVERYDAY, name: 'Everyday account', balance: zar('10000'), balanceAsOf: '2026-03-01T08:00:00Z' })] }));
    expect(result.status).toBe('insufficient_data');
    expect(result.amount).toBeNull();
    expect(result.explanation.missing[0]).toMatch(/stale \(216 h old, limit 48 h\)/);
  });

  it('is provisional when some eligible balances are unknown or stale, counting only fresh ones', () => {
    const result = safeToSpend(
      baseInput({
        accounts: [
          account({ id: EVERYDAY, name: 'Everyday account', balance: zar('10000') }),
          account({ id: SAVINGS, name: 'Stale savings', kind: 'savings', balance: zar('5000'), balanceAsOf: '2026-03-01' }),
          account({ id: uid(120), name: 'Undated', balance: zar('5000'), balanceAsOf: null }),
        ],
      }),
    );
    expect(result.status).toBe('provisional');
    expect(result.eligibleCash).toEqual(zar('10000'));
    expect(result.confidence).toBe('medium');
  });

  it('converts foreign balances and is provisional when a rate is missing', () => {
    const accounts = [account({ id: EVERYDAY, name: 'Everyday account', balance: zar('10000') }), account({ id: USD_ACCOUNT, name: 'USD account', balance: usd('100') })];
    const converted = safeToSpend(baseInput({ accounts }));
    expect(converted.status).toBe('ok');
    expect(converted.eligibleCash).toEqual(zar('11850'));
    expect(converted.explanation.items.find((i) => i.label === 'USD account balance')?.fx).toEqual(
      expect.objectContaining({ from: 'USD', to: 'ZAR', rate: '18.5', rateSource: 'test-rates' }),
    );
    const missing = safeToSpend(baseInput({ accounts, fx: new FxTable() }));
    expect(missing.status).toBe('provisional');
    expect(missing.eligibleCash).toEqual(zar('10000'));
  });

  it('is provisional when no recurring or obligation data was ever confirmed', () => {
    const result = safeToSpend(baseInput({ recurring: [recurring({ id: RENT, name: 'Detected rent', status: 'suggested', confirmed: false, detected: true })] }));
    expect(result.status).toBe('provisional');
    expect(result.explanation.missing).toContain('No recurring bills or obligations have been confirmed yet, so upcoming commitments may be missing');
    expect(safeToSpend(baseInput({ recurring: [], planningDataConfirmed: true })).status).toBe('ok');
  });

  it('counts suggested outflows conservatively but never suggested income', () => {
    const result = safeToSpend(
      baseInput({
        recurring: [
          recurring({ id: RENT, name: 'Rent', nextDueOn: '2026-03-25', amount: { amount: '4000', currency: 'ZAR' } }),
          recurring({ id: uid(203), name: 'Detected streaming', status: 'suggested', confirmed: false, nextDueOn: '2026-03-18', amount: { amount: '150', currency: 'ZAR' } }),
          recurring({ id: uid(204), name: 'Detected income', status: 'suggested', confirmed: false, direction: 'in', kind: 'income', nextDueOn: '2026-03-18' }),
        ],
      }),
    );
    expect(result.obligationsInHorizon).toEqual(zar('4150'));
    expect(result.expectedInflowsInHorizon).toEqual(zar('0'));
  });

  it('lowers confidence when data is older than half the stale limit', () => {
    const result = safeToSpend(baseInput({ accounts: [account({ id: EVERYDAY, name: 'Everyday account', balance: zar('10000'), balanceAsOf: '2026-03-09T00:00:00Z' })] }));
    expect(result.status).toBe('ok');
    expect(result.confidence).toBe('medium');
  });

  it('flags recurring items that cannot be scheduled', () => {
    const result = safeToSpend(baseInput({ recurring: [recurring({ id: RENT, name: 'Rent', nextDueOn: '2026-03-25' }), recurring({ id: uid(205), name: 'Insurance', nextDueOn: null })] }));
    expect(result.status).toBe('provisional');
  });
});

describe('safeToSpend: horizon', () => {
  const salary = recurring({ id: SALARY, name: 'Salary', direction: 'in', kind: 'salary', nextDueOn: '2026-03-20', amount: { amount: '30000', currency: 'ZAR' } });

  it('runs until the next confirmed income date', () => {
    const result = safeToSpend(
      baseInput({
        recurring: [recurring({ id: RENT, name: 'Rent', nextDueOn: '2026-03-25', amount: { amount: '4000', currency: 'ZAR' } }), salary],
        settings: { ...baseInput().settings, horizonBasis: 'next_income' },
      }),
    );
    expect(result.horizon).toEqual({ from: TODAY, to: '2026-03-20', days: 10, basis: 'Until the next confirmed income on 2026-03-20 (Salary)' });
    expect(result.obligationsInHorizon).toEqual(zar('0'));
    expect(amountOf(result)).toBe('10000');
  });

  it('falls back to fixed days without a confirmed income date', () => {
    const result = safeToSpend(
      baseInput({
        recurring: [recurring({ id: RENT, name: 'Rent', nextDueOn: '2026-03-25' }), { ...salary, confirmed: false }],
        settings: { ...baseInput().settings, horizonBasis: 'next_income', horizonDays: 14 },
      }),
    );
    expect(result.horizon.days).toBe(14);
    expect(result.explanation.assumptions).toContain('No confirmed income date found within 120 days; using a fixed 14-day horizon');
  });

  it('applies scenarios before projecting', () => {
    const result = safeToSpend(
      baseInput({ scenario: { id: uid(800), adjustments: [{ type: 'one_off', amount: '1500', currency: 'ZAR', date: '2026-03-15', direction: 'out', label: 'Repair', entityId: null }] } }),
    );
    expect(result.obligationsInHorizon).toEqual(zar('5500'));
    expect(result.explanation.items).toContainEqual(expect.objectContaining({ label: 'Repair on 2026-03-15', links: [{ kind: 'scenario', id: uid(800), label: 'Scenario' }] }));
  });
});
