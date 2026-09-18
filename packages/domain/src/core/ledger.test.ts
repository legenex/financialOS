import { describe, expect, it } from 'vitest';
import { dec, money } from '../money';
import {
  amendPendingEntry,
  assertValidEntry,
  buildDividendEntry,
  buildFeeEntry,
  buildFxConversionEntry,
  buildIncomeExpenseEntry,
  buildInterestEntry,
  buildInvestmentTradeEntry,
  buildOpeningBalanceEntry,
  buildRefundEntry,
  buildSplitEntry,
  buildTransferEntry,
  chartOf,
  computeLedgerBalances,
  correctEntry,
  entityBalanceSheet,
  findSystemAccount,
  ImmutableEntryError,
  ledgerAccountBalance,
  LedgerError,
  postPendingEntry,
  reverseEntry,
  trialBalance,
  validateEntry,
  type JournalEntry,
  type LedgerAccount,
  type OpeningBalanceBasis,
} from './ledger';
import { splitAmount, SplitError, type SplitShare } from './split';
import { randomInt, seededRandom, unitsToDecimal } from './test-support';

const P = 'ent-person';
const C = 'ent-company';

const accounts: LedgerAccount[] = [
  { id: 'p-bank-usd', entityId: P, name: 'Personal current USD', type: 'asset', subtype: 'bank', currency: 'USD', systemRole: null },
  { id: 'p-bank-zar', entityId: P, name: 'Personal current ZAR', type: 'asset', subtype: 'bank', currency: 'ZAR', systemRole: null },
  { id: 'p-savings-usd', entityId: P, name: 'Personal savings USD', type: 'asset', subtype: 'bank', currency: 'USD', systemRole: null },
  { id: 'p-fx', entityId: P, name: 'FX clearing', type: 'equity', subtype: null, currency: null, systemRole: 'fx_clearing' },
  { id: 'p-obe', entityId: P, name: 'Opening balance equity', type: 'equity', subtype: null, currency: null, systemRole: 'opening_balance_equity' },
  { id: 'p-due', entityId: P, name: 'Due from companies', type: 'asset', subtype: null, currency: null, systemRole: 'intercompany_due' },
  { id: 'p-salary', entityId: P, name: 'Salary', type: 'income', subtype: null, currency: null, systemRole: null },
  { id: 'p-groceries', entityId: P, name: 'Groceries', type: 'expense', subtype: null, currency: null, systemRole: null },
  { id: 'p-household', entityId: P, name: 'Household', type: 'expense', subtype: null, currency: null, systemRole: null },
  { id: 'p-dining', entityId: P, name: 'Dining', type: 'expense', subtype: null, currency: null, systemRole: null },
  { id: 'p-fees', entityId: P, name: 'Bank fees', type: 'expense', subtype: 'fee', currency: null, systemRole: null },
  { id: 'p-tax', entityId: P, name: 'Withholding tax', type: 'expense', subtype: 'tax', currency: null, systemRole: null },
  { id: 'p-card', entityId: P, name: 'Credit card', type: 'liability', subtype: 'card', currency: 'USD', systemRole: null },
  { id: 'p-broker-cash', entityId: P, name: 'Broker cash', type: 'asset', subtype: 'cash', currency: 'USD', systemRole: null },
  { id: 'p-position', entityId: P, name: 'Example Index Fund position', type: 'asset', subtype: 'investment_position', currency: 'USD', systemRole: null },
  { id: 'p-gains', entityId: P, name: 'Realised gains', type: 'income', subtype: 'realised_gain', currency: null, systemRole: null },
  { id: 'p-dividends', entityId: P, name: 'Dividends', type: 'income', subtype: null, currency: null, systemRole: null },
  { id: 'p-interest', entityId: P, name: 'Interest income', type: 'income', subtype: null, currency: null, systemRole: null },
  { id: 'p-interest-exp', entityId: P, name: 'Interest expense', type: 'expense', subtype: null, currency: null, systemRole: null },
  { id: 'c-bank-usd', entityId: C, name: 'Company current USD', type: 'asset', subtype: 'bank', currency: 'USD', systemRole: null },
  { id: 'c-bank-zar', entityId: C, name: 'Company current ZAR', type: 'asset', subtype: 'bank', currency: 'ZAR', systemRole: null },
  { id: 'c-due', entityId: C, name: 'Due to owner', type: 'liability', subtype: null, currency: null, systemRole: 'intercompany_due' },
  { id: 'c-sales', entityId: C, name: 'Sales', type: 'income', subtype: null, currency: null, systemRole: null },
];
const chart = chartOf(accounts);

function expense(id: string, amount: string, date = '2026-03-01', extra: Partial<Parameters<typeof buildIncomeExpenseEntry>[0]> = {}): JournalEntry {
  return buildIncomeExpenseEntry(
    {
      id,
      effectiveDate: date,
      description: `Expense ${id}`,
      direction: 'expense',
      entityId: P,
      cashLedgerAccountId: 'p-bank-usd',
      pnlLedgerAccountId: 'p-groceries',
      amount: money(amount, 'USD'),
      categoryId: 'cat-groceries',
      economicOwnerEntityId: P,
      ...extra,
    },
    { chart },
  );
}

function sumByCurrency(entry: JournalEntry): Record<string, string> {
  const out: Record<string, ReturnType<typeof dec>> = {};
  for (const l of entry.lines) out[l.currency] = (out[l.currency] ?? dec('0')).plus(dec(l.amount));
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toFixed()]));
}

describe('splitAmount', () => {
  it('splits by weight without losing minor units', () => {
    expect(splitAmount(money('100', 'USD'), [{ kind: 'weight', weight: '1' }, { kind: 'weight', weight: '1' }, { kind: 'weight', weight: '1' }]).map((m) => m.amount)).toEqual([
      '33.34',
      '33.33',
      '33.33',
    ]);
  });

  it('applies fixed parts first and shares the remainder, following the sign of the total', () => {
    const parts = splitAmount(money('-100.01', 'USD'), [
      { kind: 'fixed', amount: '20' },
      { kind: 'weight', weight: '60' },
      { kind: 'weight', weight: '40' },
    ]);
    expect(parts.map((m) => m.amount)).toEqual(['-20', '-48.01', '-32']);
  });

  it('refuses shares that cannot cover the total exactly', () => {
    expect(() => splitAmount(money('10', 'USD'), [{ kind: 'fixed', amount: '11' }])).toThrow(SplitError);
    expect(() => splitAmount(money('10', 'USD'), [{ kind: 'fixed', amount: '9' }])).toThrow(/unallocated/);
    expect(() => splitAmount(money('10', 'USD'), [{ kind: 'weight', weight: '-1' }])).toThrow(SplitError);
    expect(() => splitAmount(money('10', 'USD'), [{ kind: 'fixed', amount: '1.001' }, { kind: 'weight', weight: '1' }])).toThrow(/precision/);
    expect(() => splitAmount(money('10', 'USD'), [])).toThrow(SplitError);
    expect(() => splitAmount(money('10.001', 'USD'), [{ kind: 'weight', weight: '1' }])).toThrow(/precision/);
  });

  it('always sums exactly for random totals, weights and fixed parts (seeded property loop)', () => {
    const rand = seededRandom(20260917);
    for (let i = 0; i < 2000; i += 1) {
      const currency = ['USD', 'JPY', 'BTC', 'KWD'][randomInt(rand, 0, 3)]!;
      const scale = { USD: 2, JPY: 0, BTC: 8, KWD: 3 }[currency]!;
      const totalUnits = BigInt(randomInt(rand, 0, 1_000_000_000)) * (rand() < 0.5 ? -1n : 1n);
      const total = money(unitsToDecimal(totalUnits, scale), currency);
      const magnitude = totalUnits < 0n ? -totalUnits : totalUnits;
      const fixedUnits = rand() < 0.4 && magnitude > 0n ? BigInt(randomInt(rand, 0, Number(magnitude % 1_000_000n))) : null;
      const shares: SplitShare[] = [];
      if (fixedUnits !== null && fixedUnits <= magnitude) shares.push({ kind: 'fixed', amount: unitsToDecimal(fixedUnits, scale) });
      const weightCount = randomInt(rand, 1, 6);
      for (let w = 0; w < weightCount; w += 1) shares.push({ kind: 'weight', weight: String(randomInt(rand, w === 0 ? 1 : 0, 97)) });
      const parts = splitAmount(total, shares);
      const sum = parts.reduce((acc, p) => acc.plus(dec(p.amount)), dec('0'));
      expect(sum.equals(dec(total.amount))).toBe(true);
      for (const p of parts) {
        expect(dec(p.amount).decimalPlaces()).toBeLessThanOrEqual(scale);
        if (!dec(p.amount).isZero()) expect(dec(p.amount).isNegative()).toBe(totalUnits < 0n);
      }
    }
  });
});

describe('validateEntry', () => {
  const base: JournalEntry = {
    id: 'e1',
    effectiveDate: '2026-03-01',
    kind: 'adjustment',
    status: 'posted',
    description: 'test',
    reversesEntryId: null,
    reversedByEntryId: null,
    replacesEntryId: null,
    refundOfEntryId: null,
    sourceRecordIds: [],
    metadata: {},
    lines: [],
  };
  const line = (ledgerAccountId: string, amount: string, currency = 'USD', entityId = P) => ({
    ledgerAccountId,
    entityId,
    amount,
    currency,
    counterpartyEntityId: null,
    economicOwnerEntityId: null,
    categoryId: null,
    nature: 'unknown' as const,
    memo: null,
  });
  const codes = (entry: JournalEntry, options = {}) => validateEntry(entry, options).issues.map((i) => i.code);

  it('accepts a balanced entry', () => {
    expect(validateEntry({ ...base, lines: [line('p-groceries', '10.5'), line('p-bank-usd', '-10.5')] }, { chart }).ok).toBe(true);
  });

  it('requires at least two lines', () => {
    expect(codes({ ...base, lines: [line('p-groceries', '0.01')] })).toContain('too_few_lines');
  });

  it('requires a zero sum per currency', () => {
    expect(codes({ ...base, lines: [line('p-groceries', '10'), line('p-bank-usd', '-9.99')] })).toContain('unbalanced');
    // Balanced in total but not per currency.
    expect(codes({ ...base, lines: [line('p-bank-usd', '10'), line('p-bank-zar', '-10', 'ZAR')] })).toEqual(['unbalanced', 'unbalanced']);
  });

  it('requires each entity to balance on its own', () => {
    expect(codes({ ...base, lines: [line('p-bank-usd', '10'), line('c-bank-usd', '-10', 'USD', C)] })).toEqual(['unbalanced_entity', 'unbalanced_entity']);
    expect(validateEntry({ ...base, lines: [line('p-bank-usd', '10'), line('c-bank-usd', '-10', 'USD', C)] }, { perEntity: false }).ok).toBe(true);
  });

  it('rejects zero lines, excess precision, bad amounts, bad currencies and bad dates', () => {
    expect(codes({ ...base, lines: [line('p-groceries', '0'), line('p-bank-usd', '0')] })).toContain('zero_amount');
    expect(codes({ ...base, lines: [line('p-groceries', '0.001'), line('p-bank-usd', '-0.001')] })).toContain('precision');
    expect(codes({ ...base, lines: [line('x', '1.5e3'), line('y', '-1500')] })).toContain('invalid_amount');
    expect(codes({ ...base, lines: [line('x', '1', 'usd'), line('y', '-1', 'usd')] })).toContain('invalid_currency');
    expect(codes({ ...base, effectiveDate: '2026-02-30', lines: [line('x', '1'), line('y', '-1')] })).toContain('invalid_date');
    // JPY has no minor units; BTC has eight.
    expect(codes({ ...base, lines: [line('x', '1.5', 'JPY'), line('y', '-1.5', 'JPY')] })).toContain('precision');
    expect(validateEntry({ ...base, lines: [line('x', '0.00000001', 'BTC'), line('y', '-0.00000001', 'BTC')] }).ok).toBe(true);
  });

  it('checks accounts against the chart', () => {
    expect(codes({ ...base, lines: [line('nope', '1'), line('p-bank-usd', '-1')] }, { chart })).toContain('unknown_account');
    expect(codes({ ...base, lines: [line('p-bank-zar', '1'), line('p-groceries', '-1')] }, { chart })).toContain('account_currency_mismatch');
    expect(codes({ ...base, lines: [line('c-bank-usd', '1'), line('c-sales', '-1')] }, { chart })).toContain('account_entity_mismatch');
  });

  it('checks link consistency', () => {
    expect(codes({ ...base, kind: 'reversal', lines: [line('x', '1'), line('y', '-1')] })).toContain('invalid_link');
    expect(codes({ ...base, status: 'reversed', lines: [line('x', '1'), line('y', '-1')] })).toContain('invalid_link');
    expect(codes({ ...base, kind: 'refund', lines: [line('x', '1'), line('y', '-1')] })).toContain('invalid_link');
    expect(() => assertValidEntry({ ...base, lines: [] })).toThrow(LedgerError);
  });

  it('refuses duplicate or malformed chart accounts', () => {
    expect(() => chartOf([accounts[0]!, accounts[0]!])).toThrow(/Duplicate/);
    expect(() => chartOf([{ ...accounts[0]!, systemRole: 'bogus' as never }])).toThrow(/Unknown system role/);
  });

  it('finds system accounts, preferring a currency-specific one', () => {
    const extra = chartOf([...accounts, { id: 'p-fx-usd', entityId: P, name: 'FX USD', type: 'equity', subtype: null, currency: 'USD', systemRole: 'fx_clearing' }]);
    expect(findSystemAccount(extra, P, 'fx_clearing', 'USD')?.id).toBe('p-fx-usd');
    expect(findSystemAccount(extra, P, 'fx_clearing', 'ZAR')?.id).toBe('p-fx');
    expect(findSystemAccount(extra, C, 'fx_clearing')).toBeNull();
  });
});

describe('builders', () => {
  it('builds an exact income/expense entry', () => {
    const a = expense('e-a', '0.1');
    const b = expense('e-b', '0.2');
    expect(a.lines.map((l) => [l.ledgerAccountId, l.amount])).toEqual([
      ['p-bank-usd', '-0.1'],
      ['p-groceries', '0.1'],
    ]);
    expect(ledgerAccountBalance([a, b], 'p-groceries', 'USD').amount).toBe('0.3');
    expect(ledgerAccountBalance([a, b], 'p-bank-usd', 'USD').amount).toBe('-0.3');
    const income = buildIncomeExpenseEntry(
      { id: 'i1', effectiveDate: '2026-03-25', description: 'Salary', direction: 'income', entityId: P, cashLedgerAccountId: 'p-bank-usd', pnlLedgerAccountId: 'p-salary', amount: money('123456789012.34', 'USD'), nature: 'salary', counterpartyEntityId: C },
      { chart },
    );
    expect(income.lines.map((l) => [l.amount, l.nature, l.counterpartyEntityId])).toEqual([
      ['123456789012.34', 'salary', C],
      ['-123456789012.34', 'salary', C],
    ]);
  });

  it('rejects non-positive amounts and mismatched account types', () => {
    expect(() => expense('bad', '0')).toThrow(/positive/);
    expect(() => expense('bad', '-5')).toThrow(/positive/);
    expect(() => expense('bad', '1.234')).toThrow(/precision/);
    expect(() => expense('bad', '5', '2026-03-01', { pnlLedgerAccountId: 'p-salary' })).toThrow(/type expense/);
    expect(() => expense('bad', '5', '2026-03-01', { cashLedgerAccountId: 'p-groceries' })).toThrow(LedgerError);
  });

  it('builds a same-entity transfer', () => {
    const t = buildTransferEntry({ id: 't1', effectiveDate: '2026-03-02', description: 'To savings', amount: money('250', 'USD'), from: { entityId: P, ledgerAccountId: 'p-bank-usd' }, to: { entityId: P, ledgerAccountId: 'p-savings-usd' } }, { chart });
    expect(t.lines.map((l) => [l.ledgerAccountId, l.amount, l.nature])).toEqual([
      ['p-bank-usd', '-250', 'transfer_internal'],
      ['p-savings-usd', '250', 'transfer_internal'],
    ]);
    expect(() =>
      buildTransferEntry({ id: 't2', effectiveDate: '2026-03-02', description: 'x', amount: money('1', 'USD'), from: { entityId: P, ledgerAccountId: 'p-bank-usd' }, to: { entityId: P, ledgerAccountId: 'p-bank-usd' } }),
    ).toThrow(/two different/);
  });

  it('builds a cross-entity transfer that balances in each entity', () => {
    const input = {
      id: 't3',
      effectiveDate: '2026-03-02',
      description: 'Owner contribution',
      amount: money('1000', 'USD'),
      from: { entityId: P, ledgerAccountId: 'p-bank-usd' },
      to: { entityId: C, ledgerAccountId: 'c-bank-usd' },
      nature: 'owner_contribution' as const,
    };
    expect(() => buildTransferEntry(input, { chart })).toThrow(/intercompany/);
    const t = buildTransferEntry({ ...input, intercompany: { fromDueLedgerAccountId: 'p-due', toDueLedgerAccountId: 'c-due' } }, { chart });
    expect(t.lines).toHaveLength(4);
    expect(t.lines.every((l) => l.counterpartyEntityId === (l.entityId === P ? C : P))).toBe(true);
    const sheetP = entityBalanceSheet([t], chart, P);
    const sheetC = entityBalanceSheet([t], chart, C);
    expect(sheetP.checks.every((c) => c.balanced)).toBe(true);
    expect(sheetC.checks.every((c) => c.balanced)).toBe(true);
    expect(() => buildTransferEntry({ ...input, intercompany: { fromDueLedgerAccountId: 'p-bank-usd', toDueLedgerAccountId: 'c-due' } }, { chart })).toThrow(/intercompany_due/);
  });

  it('builds a cross-currency conversion that balances per currency', () => {
    const fx = buildFxConversionEntry(
      {
        id: 'fx1',
        effectiveDate: '2026-03-03',
        description: 'Convert USD to ZAR',
        sold: { entityId: P, ledgerAccountId: 'p-bank-usd', amount: money('100', 'USD') },
        bought: { entityId: P, ledgerAccountId: 'p-bank-zar', amount: money('1834.50', 'ZAR') },
        fxClearing: { soldCurrencyLedgerAccountId: 'p-fx', boughtCurrencyLedgerAccountId: 'p-fx' },
        referenceRate: { rate: '18.40', source: 'test-feed', asOf: '2026-03-03' },
      },
      { chart },
    );
    expect(sumByCurrency(fx)).toEqual({ USD: '0', ZAR: '0' });
    expect(fx.lines.map((l) => [l.ledgerAccountId, l.amount, l.currency])).toEqual([
      ['p-bank-usd', '-100', 'USD'],
      ['p-fx', '100', 'USD'],
      ['p-fx', '-1834.5', 'ZAR'],
      ['p-bank-zar', '1834.5', 'ZAR'],
    ]);
    expect(fx.metadata.impliedRate).toBe('18.345');
    expect(fx.metadata.ratePair).toBe('USD/ZAR');
    expect(fx.metadata.rateDeviation).toBe(dec('0.055').dividedBy('18.40').toDecimalPlaces(18).toFixed());
    // The FX clearing account holds +100 USD and −1834.50 ZAR: the trading-account position.
    const balances = computeLedgerBalances([fx]).filter((b) => b.ledgerAccountId === 'p-fx');
    expect(balances.map((b) => [b.currency, b.balance.amount])).toEqual([
      ['USD', '100'],
      ['ZAR', '-1834.5'],
    ]);
  });

  it('refuses same-currency conversions and non-FX clearing accounts', () => {
    const input = {
      id: 'fx2',
      effectiveDate: '2026-03-03',
      description: 'x',
      sold: { entityId: P, ledgerAccountId: 'p-bank-usd', amount: money('100', 'USD') },
      bought: { entityId: P, ledgerAccountId: 'p-savings-usd', amount: money('100', 'USD') },
      fxClearing: { soldCurrencyLedgerAccountId: 'p-fx', boughtCurrencyLedgerAccountId: 'p-fx' },
    };
    expect(() => buildFxConversionEntry(input, { chart })).toThrow(/different currencies/);
    expect(() =>
      buildFxConversionEntry(
        { ...input, bought: { entityId: P, ledgerAccountId: 'p-bank-zar', amount: money('1800', 'ZAR') }, fxClearing: { soldCurrencyLedgerAccountId: 'p-obe', boughtCurrencyLedgerAccountId: 'p-fx' } },
        { chart },
      ),
    ).toThrow(/fx_clearing/);
  });

  it('builds a cross-entity conversion balanced per entity and currency', () => {
    const fx = buildFxConversionEntry(
      {
        id: 'fx3',
        effectiveDate: '2026-03-04',
        description: 'Owner funds company in ZAR',
        sold: { entityId: P, ledgerAccountId: 'p-bank-usd', amount: money('50', 'USD') },
        bought: { entityId: C, ledgerAccountId: 'c-bank-zar', amount: money('917.25', 'ZAR') },
        fxClearing: { soldCurrencyLedgerAccountId: 'p-fx', boughtCurrencyLedgerAccountId: 'p-fx' },
        intercompany: { fromDueLedgerAccountId: 'p-due', toDueLedgerAccountId: 'c-due' },
      },
      { chart },
    );
    expect(validateEntry(fx, { chart, perEntity: true }).ok).toBe(true);
    expect(fx.lines).toHaveLength(6);
    expect(fx.metadata.impliedRate).toBe('18.345');
  });

  it('builds a split entry whose parts sum exactly', () => {
    const split = buildSplitEntry(
      {
        id: 's1',
        effectiveDate: '2026-03-05',
        description: 'Supermarket',
        entityId: P,
        direction: 'expense',
        cashLedgerAccountId: 'p-bank-usd',
        total: money('100', 'USD'),
        parts: [
          { ledgerAccountId: 'p-groceries', share: { kind: 'weight', weight: '1' }, categoryId: 'cat-groceries' },
          { ledgerAccountId: 'p-household', share: { kind: 'weight', weight: '1' }, categoryId: 'cat-household' },
          { ledgerAccountId: 'p-dining', share: { kind: 'weight', weight: '1' }, categoryId: 'cat-dining' },
        ],
      },
      { chart },
    );
    expect(split.lines.map((l) => l.amount)).toEqual(['-100', '33.34', '33.33', '33.33']);
    const tiny = buildSplitEntry({
      id: 's2',
      effectiveDate: '2026-03-05',
      description: 'Tiny',
      entityId: P,
      direction: 'expense',
      cashLedgerAccountId: 'p-bank-usd',
      total: money('0.01', 'USD'),
      parts: [
        { ledgerAccountId: 'p-groceries', share: { kind: 'weight', weight: '1' } },
        { ledgerAccountId: 'p-household', share: { kind: 'weight', weight: '1' } },
      ],
    });
    expect(tiny.lines.map((l) => l.amount)).toEqual(['-0.01', '0.01']);
    expect(tiny.metadata.omittedZeroParts).toBe('2');
  });

  it('keeps random split entries balanced (seeded property loop)', () => {
    const rand = seededRandom(7);
    for (let i = 0; i < 300; i += 1) {
      const units = BigInt(randomInt(rand, 1, 50_000_000));
      const parts = Array.from({ length: randomInt(rand, 1, 5) }, (_, k) => ({
        ledgerAccountId: ['p-groceries', 'p-household', 'p-dining'][k % 3]!,
        share: { kind: 'weight' as const, weight: String(randomInt(rand, 1, 1000)) },
      }));
      const entry = buildSplitEntry({ id: `sp${i}`, effectiveDate: '2026-03-05', description: 'r', entityId: P, direction: 'expense', cashLedgerAccountId: 'p-bank-usd', total: money(unitsToDecimal(units, 2), 'USD'), parts }, { chart });
      expect(sumByCurrency(entry)).toEqual({ USD: '0' });
    }
  });

  it('builds a fee linked to its cause', () => {
    const fee = buildFeeEntry({ id: 'f1', effectiveDate: '2026-03-02', description: 'Transfer fee', entityId: P, cashLedgerAccountId: 'p-bank-usd', feeLedgerAccountId: 'p-fees', fee: money('1.25', 'USD'), relatedEntryId: 't1' }, { chart });
    expect(fee.kind).toBe('fee');
    expect(fee.metadata.relatedEntryId).toBe('t1');
    expect(fee.lines.map((l) => [l.amount, l.nature])).toEqual([
      ['1.25', 'fee'],
      ['-1.25', 'fee'],
    ]);
  });
});

describe('refunds', () => {
  const original = expense('buy', '80');

  it('refunds part of an expense, linked to the original', () => {
    const refund = buildRefundEntry({ id: 'r1', effectiveDate: '2026-03-10', description: 'Partial refund', original, cashLedgerAccountId: 'p-bank-usd', pnlLedgerAccountId: 'p-groceries', amount: money('30', 'USD') }, { chart });
    expect(refund.refundOfEntryId).toBe('buy');
    expect(refund.lines.map((l) => [l.ledgerAccountId, l.amount, l.categoryId, l.nature])).toEqual([
      ['p-bank-usd', '30', 'cat-groceries', 'refund'],
      ['p-groceries', '-30', 'cat-groceries', 'refund'],
    ]);
    expect(ledgerAccountBalance([original, refund], 'p-groceries', 'USD').amount).toBe('50');
    const rest = buildRefundEntry({ id: 'r2', effectiveDate: '2026-03-11', description: 'Rest', original, cashLedgerAccountId: 'p-bank-usd', pnlLedgerAccountId: 'p-groceries', priorRefunds: [refund] });
    expect(rest.lines[0]!.amount).toBe('50');
    expect(() =>
      buildRefundEntry({ id: 'r3', effectiveDate: '2026-03-12', description: 'Too much', original, cashLedgerAccountId: 'p-bank-usd', pnlLedgerAccountId: 'p-groceries', amount: money('0.01', 'USD'), priorRefunds: [refund, rest] }),
    ).toThrow(/fully refunded/);
    expect(() =>
      buildRefundEntry({ id: 'r4', effectiveDate: '2026-03-12', description: 'Too much', original, cashLedgerAccountId: 'p-bank-usd', pnlLedgerAccountId: 'p-groceries', amount: money('50.01', 'USD'), priorRefunds: [refund] }),
    ).toThrow(LedgerError);
  });

  it('refunds income in the opposite direction', () => {
    const sale = buildIncomeExpenseEntry({ id: 'sale', effectiveDate: '2026-03-01', description: 'Sale', direction: 'income', entityId: C, cashLedgerAccountId: 'c-bank-usd', pnlLedgerAccountId: 'c-sales', amount: money('40', 'USD') }, { chart });
    const refund = buildRefundEntry({ id: 'sr', effectiveDate: '2026-03-02', description: 'Customer refund', original: sale, cashLedgerAccountId: 'c-bank-usd', pnlLedgerAccountId: 'c-sales' }, { chart });
    expect(refund.lines.map((l) => l.amount)).toEqual(['-40', '40']);
  });

  it('refuses refunds of reversed or pending entries, or on accounts not in the original', () => {
    const { original: reversed } = reverseEntry(original, { id: 'rv', effectiveDate: '2026-03-02', reason: 'duplicate' });
    expect(() => buildRefundEntry({ id: 'x', effectiveDate: '2026-03-03', description: 'x', original: reversed, cashLedgerAccountId: 'p-bank-usd', pnlLedgerAccountId: 'p-groceries' })).toThrow(/Only posted/);
    expect(() => buildRefundEntry({ id: 'x', effectiveDate: '2026-03-03', description: 'x', original, cashLedgerAccountId: 'p-bank-usd', pnlLedgerAccountId: 'p-dining' })).toThrow(/no line/);
    expect(() =>
      buildRefundEntry({ id: 'x', effectiveDate: '2026-03-03', description: 'x', original, cashLedgerAccountId: 'p-bank-usd', pnlLedgerAccountId: 'p-groceries', amount: money('1', 'EUR') }),
    ).toThrow(/currency/);
  });
});

describe('reversals, corrections and immutability', () => {
  it('reverses with an exact negation linked both ways', () => {
    const original = expense('orig', '19.99');
    const { original: reversed, reversal } = reverseEntry(original, { id: 'rev', effectiveDate: '2026-03-05', reason: 'Imported twice' }, { chart });
    expect(original.lines.map((l) => l.amount)).toEqual(['-19.99', '19.99']);
    expect(reversal.lines.map((l) => l.amount)).toEqual(['19.99', '-19.99']);
    expect(reversal.reversesEntryId).toBe('orig');
    expect(reversal.kind).toBe('reversal');
    expect(reversal.metadata.reason).toBe('Imported twice');
    expect(reversed.status).toBe('reversed');
    expect(reversed.reversedByEntryId).toBe('rev');
    expect(original.status).toBe('posted');
    expect(ledgerAccountBalance([reversed, reversal], 'p-groceries', 'USD').amount).toBe('0');
    expect(ledgerAccountBalance([reversed, reversal], 'p-groceries', 'USD', { asOf: '2026-03-04' }).amount).toBe('19.99');
  });

  it('refuses to reverse a reversal', () => {
    const { reversal } = reverseEntry(expense('o1', '5'), { id: 'r1', effectiveDate: '2026-03-02', reason: 'mistake' });
    let caught: unknown;
    try {
      reverseEntry(reversal, { id: 'r2', effectiveDate: '2026-03-03', reason: 'undo' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerError);
    expect((caught as LedgerError).code).toBe('reversal_of_reversal');
  });

  it('refuses to reverse an already reversed entry, a pending entry, or with an earlier date', () => {
    const { original: reversed } = reverseEntry(expense('o2', '5'), { id: 'r3', effectiveDate: '2026-03-02', reason: 'mistake' });
    expect(() => reverseEntry(reversed, { id: 'r4', effectiveDate: '2026-03-03', reason: 'again' })).toThrow(expect.objectContaining({ code: 'already_reversed' }));
    const pending = expense('o3', '5', '2026-03-01', { status: 'pending' });
    expect(() => reverseEntry(pending, { id: 'r5', effectiveDate: '2026-03-03', reason: 'x' })).toThrow(expect.objectContaining({ code: 'not_posted' }));
    expect(() => reverseEntry(expense('o4', '5', '2026-03-10'), { id: 'r6', effectiveDate: '2026-03-09', reason: 'x' })).toThrow(expect.objectContaining({ code: 'invalid_date' }));
    expect(() => reverseEntry(expense('o5', '5'), { id: 'r7', effectiveDate: '2026-03-09', reason: ' ' })).toThrow(expect.objectContaining({ code: 'missing_field' }));
  });

  it('corrects an entry through reversal plus replacement', () => {
    const original = expense('wrong', '45');
    const replacement = expense('right', '54');
    const result = correctEntry(original, replacement, { id: 'fix', effectiveDate: '2026-03-06', reason: 'Digits transposed' }, { chart });
    expect(result.replacement.replacesEntryId).toBe('wrong');
    expect(result.replacement.metadata.correctionOf).toBe('wrong');
    expect(result.original.status).toBe('reversed');
    const all = [result.original, result.reversal, result.replacement];
    expect(ledgerAccountBalance(all, 'p-groceries', 'USD').amount).toBe('54');
    expect(() => correctEntry(result.original, expense('again', '1'), { id: 'fix2', effectiveDate: '2026-03-07', reason: 'x' })).toThrow(LedgerError);
    expect(() => correctEntry(expense('w2', '1'), result.reversal, { id: 'fix3', effectiveDate: '2026-03-07', reason: 'x' })).toThrow(/reversal/);
  });

  it('keeps posted entries immutable', () => {
    const entry = expense('frozen', '10');
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.lines[0])).toBe(true);
    expect(() => {
      (entry as { status: string }).status = 'pending';
    }).toThrow(TypeError);
    expect(() => {
      (entry.lines[0] as { amount: string }).amount = '11';
    }).toThrow(TypeError);
    expect(() => amendPendingEntry(entry, { description: 'changed' })).toThrow(ImmutableEntryError);
    expect(() => postPendingEntry(entry)).toThrow(ImmutableEntryError);
  });

  it('allows pending entries to be amended and posted', () => {
    const pending = expense('pend', '12', '2026-03-01', { status: 'pending' });
    expect(computeLedgerBalances([pending])).toEqual([]);
    expect(computeLedgerBalances([pending], { includePending: true })).toHaveLength(2);
    const amended = amendPendingEntry(pending, { lines: pending.lines.map((l) => ({ ...l, amount: dec(l.amount).times('1.5').toFixed() })) }, { chart });
    expect(amended.lines.map((l) => l.amount)).toEqual(['-18', '18']);
    expect(() => amendPendingEntry(pending, { lines: [pending.lines[0]!] })).toThrow(LedgerError);
    const posted = postPendingEntry(amended, { effectiveDate: '2026-03-03' });
    expect(posted.status).toBe('posted');
    expect(posted.effectiveDate).toBe('2026-03-03');
    expect(pending.status).toBe('pending');
  });
});

describe('opening balances', () => {
  const base = { id: 'ob1', effectiveDate: '2026-01-01', description: 'Opening', entityId: P, openingBalanceEquityLedgerAccountId: 'p-obe', basis: 'statement_opening' as OpeningBalanceBasis };

  it('posts a verified opening balance against opening balance equity', () => {
    const asset = buildOpeningBalanceEntry({ ...base, ledgerAccountId: 'p-bank-usd', balance: money('1500.25', 'USD') }, { chart });
    expect(asset.lines.map((l) => [l.ledgerAccountId, l.amount, l.nature])).toEqual([
      ['p-bank-usd', '1500.25', 'opening_balance'],
      ['p-obe', '-1500.25', 'opening_balance'],
    ]);
    expect(asset.metadata.openingBasis).toBe('statement_opening');
    const debt = buildOpeningBalanceEntry({ ...base, id: 'ob2', ledgerAccountId: 'p-card', balance: money('-320', 'USD') }, { chart });
    expect(debt.lines.map((l) => l.amount)).toEqual(['-320', '320']);
  });

  it('refuses owner-reported snapshots, zero balances and non-equity counter accounts', () => {
    expect(() => buildOpeningBalanceEntry({ ...base, basis: 'owner_reported_total' as never, ledgerAccountId: 'p-bank-usd', balance: money('10', 'USD') })).toThrow(/valuation evidence/);
    expect(() => buildOpeningBalanceEntry({ ...base, ledgerAccountId: 'p-bank-usd', balance: money('0', 'USD') })).toThrow(expect.objectContaining({ code: 'zero_amount' }));
    expect(() => buildOpeningBalanceEntry({ ...base, ledgerAccountId: 'p-bank-usd', openingBalanceEquityLedgerAccountId: 'p-fx', balance: money('10', 'USD') }, { chart })).toThrow(/opening_balance_equity/);
    expect(() => buildOpeningBalanceEntry({ ...base, ledgerAccountId: 'p-groceries', balance: money('10', 'USD') }, { chart })).toThrow(/asset or liability/);
  });
});

describe('investments', () => {
  const header = { effectiveDate: '2026-04-01', description: 'Trade', entityId: P, cashLedgerAccountId: 'p-broker-cash', positionLedgerAccountId: 'p-position', instrumentId: 'inst-example-fund' };

  it('buys at cost with the fee expensed, tracking quantity separately', () => {
    const { entry, position } = buildInvestmentTradeEntry(
      { ...header, id: 'buy1', side: 'buy', quantity: '12.5', consideration: money('1000', 'USD'), fee: { amount: money('1.5', 'USD'), ledgerAccountId: 'p-fees' } },
      { chart },
    );
    expect(entry.lines.map((l) => [l.ledgerAccountId, l.amount])).toEqual([
      ['p-position', '1000'],
      ['p-fees', '1.5'],
      ['p-broker-cash', '-1001.5'],
    ]);
    expect(entry.metadata).toMatchObject({ side: 'buy', quantity: '12.5', unitPrice: '80' });
    expect(position).toMatchObject({ quantityDelta: '12.5', costDelta: { amount: '1000', currency: 'USD' }, instrumentId: 'inst-example-fund' });
    expect(entry.lines.some((l) => l.amount === '12.5')).toBe(false);
  });

  it('capitalises the fee into cost when asked', () => {
    const { entry, position } = buildInvestmentTradeEntry({ ...header, id: 'buy2', side: 'buy', quantity: '3', consideration: money('300', 'USD'), fee: { amount: money('0.99', 'USD'), ledgerAccountId: 'p-fees', capitalise: true } }, { chart });
    expect(entry.lines.map((l) => l.amount)).toEqual(['300.99', '-300.99']);
    expect(position.costDelta.amount).toBe('300.99');
  });

  it('sells with realised gains and losses', () => {
    const gain = buildInvestmentTradeEntry(
      { ...header, id: 'sell1', side: 'sell', quantity: '5', consideration: money('450', 'USD'), costBasisRelieved: money('400', 'USD'), realisedGainLedgerAccountId: 'p-gains', fee: { amount: money('2', 'USD'), ledgerAccountId: 'p-fees' } },
      { chart },
    );
    expect(gain.entry.lines.map((l) => [l.ledgerAccountId, l.amount])).toEqual([
      ['p-broker-cash', '448'],
      ['p-fees', '2'],
      ['p-position', '-400'],
      ['p-gains', '-50'],
    ]);
    expect(gain.position).toMatchObject({ quantityDelta: '-5', costDelta: { amount: '-400' } });
    const loss = buildInvestmentTradeEntry(
      { ...header, id: 'sell2', side: 'sell', quantity: '1', consideration: money('70', 'USD'), costBasisRelieved: money('80', 'USD'), realisedGainLedgerAccountId: 'p-gains', fee: { amount: money('1', 'USD'), ledgerAccountId: 'p-fees', capitalise: true } },
      { chart },
    );
    expect(loss.entry.lines.map((l) => [l.ledgerAccountId, l.amount])).toEqual([
      ['p-broker-cash', '69'],
      ['p-position', '-80'],
      ['p-gains', '11'],
    ]);
    const even = buildInvestmentTradeEntry({ ...header, id: 'sell3', side: 'sell', quantity: '1', consideration: money('80', 'USD'), costBasisRelieved: money('80', 'USD') }, { chart });
    expect(even.entry.lines).toHaveLength(2);
  });

  it('refuses incomplete or invalid trades', () => {
    expect(() => buildInvestmentTradeEntry({ ...header, id: 'x1', side: 'sell', quantity: '1', consideration: money('10', 'USD') })).toThrow(/cost basis/);
    expect(() => buildInvestmentTradeEntry({ ...header, id: 'x2', side: 'sell', quantity: '1', consideration: money('10', 'USD'), costBasisRelieved: money('5', 'USD') })).toThrow(/realised gain account/);
    expect(() => buildInvestmentTradeEntry({ ...header, id: 'x3', side: 'buy', quantity: '0', consideration: money('10', 'USD') })).toThrow(/quantity/);
    expect(() => buildInvestmentTradeEntry({ ...header, id: 'x4', side: 'buy', quantity: '1e2', consideration: money('10', 'USD') })).toThrow(/quantity/);
    expect(() => buildInvestmentTradeEntry({ ...header, id: 'x5', side: 'buy', quantity: '1', consideration: money('10', 'USD'), costBasisRelieved: money('10', 'USD') })).toThrow(/sells only/);
    expect(() => buildInvestmentTradeEntry({ ...header, id: 'x6', side: 'buy', quantity: '1', consideration: money('10', 'USD'), fee: { amount: money('1', 'EUR'), ledgerAccountId: 'p-fees' } })).toThrow(/currency/);
    expect(() => buildInvestmentTradeEntry({ ...header, id: 'x7', side: 'sell', quantity: '1', consideration: money('10', 'USD'), costBasisRelieved: money('10', 'USD'), fee: { amount: money('10', 'USD'), ledgerAccountId: 'p-fees' } })).toThrow(/smaller/);
  });

  it('records dividends with withholding and interest in both directions', () => {
    const div = buildDividendEntry(
      { id: 'd1', effectiveDate: '2026-04-15', description: 'Dividend', entityId: P, cashLedgerAccountId: 'p-broker-cash', incomeLedgerAccountId: 'p-dividends', gross: money('10.00', 'USD'), withholding: { amount: money('1.50', 'USD'), ledgerAccountId: 'p-tax' }, instrumentId: 'inst-example-fund' },
      { chart },
    );
    expect(div.lines.map((l) => [l.ledgerAccountId, l.amount, l.nature])).toEqual([
      ['p-broker-cash', '8.5', 'dividend'],
      ['p-tax', '1.5', 'tax'],
      ['p-dividends', '-10', 'dividend'],
    ]);
    expect(div.metadata).toMatchObject({ gross: '10', withheld: '1.5', instrumentId: 'inst-example-fund' });
    const received = buildInterestEntry({ id: 'in1', effectiveDate: '2026-04-30', description: 'Interest', entityId: P, cashLedgerAccountId: 'p-savings-usd', incomeLedgerAccountId: 'p-interest', gross: money('3.21', 'USD') }, { chart });
    expect(received.lines.map((l) => l.amount)).toEqual(['3.21', '-3.21']);
    const paid = buildInterestEntry({ id: 'in2', direction: 'paid', effectiveDate: '2026-04-30', description: 'Card interest', entityId: P, cashLedgerAccountId: 'p-card', expenseLedgerAccountId: 'p-interest-exp', amount: money('4.56', 'USD') }, { chart });
    expect(paid.lines.map((l) => [l.ledgerAccountId, l.amount])).toEqual([
      ['p-interest-exp', '4.56'],
      ['p-card', '-4.56'],
    ]);
    expect(() =>
      buildDividendEntry({ id: 'd2', effectiveDate: '2026-04-15', description: 'x', entityId: P, cashLedgerAccountId: 'p-broker-cash', incomeLedgerAccountId: 'p-dividends', gross: money('1', 'USD'), withholding: { amount: money('1', 'USD'), ledgerAccountId: 'p-tax' } }),
    ).toThrow(/smaller/);
  });
});

describe('balances and reports', () => {
  const entries = [
    buildOpeningBalanceEntry({ id: 'ob', effectiveDate: '2026-01-01', description: 'Opening', entityId: P, ledgerAccountId: 'p-bank-usd', openingBalanceEquityLedgerAccountId: 'p-obe', balance: money('1000', 'USD'), basis: 'provider_balance' }, { chart }),
    buildIncomeExpenseEntry({ id: 'sal', effectiveDate: '2026-01-25', description: 'Salary', direction: 'income', entityId: P, cashLedgerAccountId: 'p-bank-usd', pnlLedgerAccountId: 'p-salary', amount: money('3000', 'USD'), nature: 'salary' }, { chart }),
    expense('food', '120.55', '2026-01-26'),
    buildFxConversionEntry(
      {
        id: 'conv',
        effectiveDate: '2026-01-27',
        description: 'FX',
        sold: { entityId: P, ledgerAccountId: 'p-bank-usd', amount: money('200', 'USD') },
        bought: { entityId: P, ledgerAccountId: 'p-bank-zar', amount: money('3700', 'ZAR') },
        fxClearing: { soldCurrencyLedgerAccountId: 'p-fx', boughtCurrencyLedgerAccountId: 'p-fx' },
      },
      { chart },
    ),
    buildIncomeExpenseEntry({ id: 'csale', effectiveDate: '2026-01-28', description: 'Sale', direction: 'income', entityId: C, cashLedgerAccountId: 'c-bank-usd', pnlLedgerAccountId: 'c-sales', amount: money('999.99', 'USD') }, { chart }),
  ];

  it('computes balances per account and currency, respecting asOf', () => {
    expect(ledgerAccountBalance(entries, 'p-bank-usd', 'USD').amount).toBe('3679.45');
    expect(ledgerAccountBalance(entries, 'p-bank-usd', 'USD', { asOf: '2026-01-25' }).amount).toBe('4000');
    expect(ledgerAccountBalance(entries, 'p-bank-zar', 'ZAR').amount).toBe('3700');
    const usd = computeLedgerBalances(entries, { entityId: P }).find((b) => b.ledgerAccountId === 'p-bank-usd')!;
    expect(usd).toMatchObject({ debits: { amount: '4000' }, credits: { amount: '320.55' } });
    expect(() => computeLedgerBalances([entries[0]!, entries[0]!])).toThrow(/more than once/);
  });

  it('produces a trial balance that balances per currency', () => {
    const tb = trialBalance(entries, chart);
    expect(tb.totals.map((t) => [t.currency, t.debits.amount, t.credits.amount, t.balanced])).toEqual([
      ['USD', '4999.99', '4999.99', true],
      ['ZAR', '3700', '3700', true],
    ]);
    expect(tb.unknownAccountIds).toEqual([]);
    expect(tb.rows.find((r) => r.ledgerAccountId === 'p-salary')).toMatchObject({ credit: { amount: '3000' }, debit: { amount: '0' }, type: 'income' });
  });

  it('produces an entity balance sheet that satisfies the accounting equation', () => {
    const sheet = entityBalanceSheet(entries, chart, P, { asOf: '2026-01-31' });
    const usd = sheet.checks.find((c) => c.currency === 'USD')!;
    expect(usd).toMatchObject({ assets: { amount: '3679.45' }, currentEarnings: { amount: '2879.45' }, balanced: true });
    expect(sheet.checks.every((c) => c.balanced)).toBe(true);
    expect(sheet.byType.find((t) => t.type === 'equity' && t.currency === 'USD')!.total.amount).toBe('800');
    expect(entityBalanceSheet(entries, chart, C).checks).toEqual([
      { currency: 'USD', assets: money('999.99', 'USD'), liabilities: money('0', 'USD'), equity: money('0', 'USD'), currentEarnings: money('999.99', 'USD'), balanced: true },
    ]);
  });
});
