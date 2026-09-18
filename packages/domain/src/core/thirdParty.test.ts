import { ClearingAccountSummary } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { money } from '../money';
import { uuid } from './test-support';
import {
  attributableForAccount,
  attributableThirdPartyBalance,
  computeClearingAccount,
  feeChargedOnTop,
  feeDeductedFromReceipt,
  ThirdPartyError,
  type ThirdPartyArrangement,
  type ThirdPartyMovement,
} from './thirdParty';

const HOLDER = uuid(10);
const THIRD = uuid(20);
const usd = (a: string) => money(a, 'USD');

const arrangement = (over: Partial<ThirdPartyArrangement> = {}): ThirdPartyArrangement => ({
  id: uuid(1),
  thirdPartyEntityId: THIRD,
  thirdPartyName: 'Third Party A',
  currency: 'USD',
  feeRate: '0.075',
  feeMode: 'deducted_from_receipt',
  feeRecipientEntityId: HOLDER,
  openingBalance: '500',
  openingAsOf: '2026-06-30',
  holderEntityId: HOLDER,
  holdingAccountId: uuid(30),
  ...over,
});

let seq = 100;
const mv = (date: string, kind: ThirdPartyMovement['kind'], amount: string, currency = 'USD'): ThirdPartyMovement => ({
  id: uuid((seq += 1)),
  date,
  kind,
  amount: money(amount, currency),
  description: `${kind} on ${date}`,
  transactionId: uuid(seq + 1000),
});

describe('fee formulas', () => {
  it('deducts the fee from the receipt', () => {
    expect(feeDeductedFromReceipt(usd('1000.00'), '0.075')).toEqual({ fee: usd('75'), net: usd('925') });
    // 100.50 × 0.05 = 5.025: half-even rounds to 5.02, half-up to 5.03.
    expect(feeDeductedFromReceipt(usd('100.50'), '0.05')).toEqual({ fee: usd('5.02'), net: usd('95.48') });
    expect(feeDeductedFromReceipt(usd('100.50'), '0.05', 'half_up')).toEqual({ fee: usd('5.03'), net: usd('95.47') });
  });

  it('separates a fee charged on top', () => {
    expect(feeChargedOnTop(usd('107.50'), '0.075')).toEqual({ principal: usd('100'), fee: usd('7.5') });
    // 100 / 1.075 = 93.0232…
    expect(feeChargedOnTop(usd('100'), '0.075')).toEqual({ principal: usd('93.02'), fee: usd('6.98') });
    // 1000.04 / 1.6 = 625.025 exactly: a rounding tie.
    expect(feeChargedOnTop(usd('1000.04'), '0.6')).toEqual({ principal: usd('625.02'), fee: usd('375.02') });
    expect(feeChargedOnTop(usd('1000.04'), '0.6', 'half_up')).toEqual({ principal: usd('625.03'), fee: usd('375.01') });
  });

  it('rejects impossible rates', () => {
    expect(() => feeDeductedFromReceipt(usd('1'), '1')).toThrow(ThirdPartyError);
    expect(() => feeChargedOnTop(usd('1'), '-0.01')).toThrow(ThirdPartyError);
  });
});

describe('computeClearingAccount', () => {
  const sequence = () => [
    mv('2026-06-15', 'receipt', '999'),
    mv('2026-07-02', 'receipt', '1000.00'),
    mv('2026-07-03', 'card_spend', '120.40'),
    mv('2026-07-05', 'transfer_out', '50'),
    mv('2026-07-06', 'reimbursement', '20.40'),
    mv('2026-07-10', 'settlement', '1000'),
    mv('2026-07-11', 'adjustment', '-0.01'),
  ];

  it('tracks the amount owed exactly with fees deducted from receipts', () => {
    const { summary, exceptions } = computeClearingAccount(arrangement(), sequence());
    expect(ClearingAccountSummary.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({
      amountOwed: usd('274.99'),
      amountOwedStatus: 'ok',
      feeModeConfirmed: true,
      feeIncomeRecognised: usd('75'),
      heldForClassification: usd('0'),
      feeIncomeIfDeducted: null,
      feeIncomeIfOnTop: null,
      openingBalance: usd('500'),
    });
    expect(summary.movements.map((m) => [m.kind, m.fee?.amount ?? null, m.effectOnOwed?.amount ?? null, m.status])).toEqual([
      ['receipt', '75', '925', 'applied'],
      ['card_spend', null, '-120.4', 'applied'],
      ['transfer_out', null, '-50', 'applied'],
      ['reimbursement', null, '20.4', 'applied'],
      ['settlement', null, '-1000', 'applied'],
      ['adjustment', null, '-0.01', 'applied'],
    ]);
    expect(summary.movements[0]!.note).toBe('Fee 75 (0.075 of 1000) deducted from the receipt');
    expect(summary.explanation.items.find((i) => i.role === 'excluded')!.note).toMatch(/already included/);
    expect(exceptions).toEqual([]);
  });

  it('recognises the principal when the fee is charged on top', () => {
    const { summary } = computeClearingAccount(arrangement({ feeMode: 'charged_on_top' }), [mv('2026-07-02', 'receipt', '107.50'), mv('2026-07-03', 'receipt', '100')]);
    expect(summary.movements.map((m) => [m.fee?.amount, m.effectOnOwed?.amount])).toEqual([
      ['7.5', '100'],
      ['6.98', '93.02'],
    ]);
    expect(summary).toMatchObject({ amountOwed: usd('693.02'), feeIncomeRecognised: usd('14.48'), amountOwedStatus: 'ok' });
    expect(summary.explanation.formula).toMatch(/÷ \(1 \+ rate\)/);
  });

  it('holds receipts and recognises no fee while the policy is unconfirmed', () => {
    const { summary, exceptions } = computeClearingAccount(arrangement({ feeMode: 'unconfirmed' }), [
      mv('2026-07-02', 'receipt', '1000'),
      mv('2026-07-03', 'receipt', '107.50'),
      mv('2026-07-04', 'card_spend', '25'),
    ]);
    expect(ClearingAccountSummary.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({
      feeModeConfirmed: false,
      heldForClassification: usd('1107.5'),
      feeIncomeRecognised: usd('0'),
      feeIncomeIfDeducted: usd('83.06'),
      feeIncomeIfOnTop: usd('77.27'),
      amountOwed: usd('475'),
      amountOwedStatus: 'provisional',
    });
    expect(summary.movements.slice(0, 2).map((m) => [m.status, m.fee, m.effectOnOwed])).toEqual([
      ['held', null, null],
      ['held', null, null],
    ]);
    expect(summary.explanation.missing).toContain('1107.5 USD is held for classification and not included');
    expect(exceptions).toEqual([
      {
        kind: 'fee_policy_unconfirmed',
        severity: 'warning',
        title: 'Confirm the fee policy for Third Party A',
        detail:
          '1107.5 USD of receipts is held until the fee is confirmed as deducted from receipts or charged on top. If fees are deducted from receipts, fee income would be 83.06 USD; if charged on top, 77.27 USD.',
        subject: { type: 'arrangement', id: uuid(1), label: 'Third Party A' },
        entityId: HOLDER,
        dedupeKey: `fee_policy_unconfirmed:arrangement:${uuid(1)}`,
      },
    ]);
    // Without a known rate the alternatives are unknown, not zero.
    const noRate = computeClearingAccount(arrangement({ feeMode: 'unconfirmed', feeRate: null }), [mv('2026-07-02', 'receipt', '10')]);
    expect(noRate.summary).toMatchObject({ feeIncomeIfDeducted: null, feeIncomeIfOnTop: null, feeRate: null });
    expect(noRate.exceptions[0]!.detail).toMatch(/fee rate is also unknown/);
  });

  it('marks the amount owed provisional when the opening balance is unknown', () => {
    const { summary, exceptions } = computeClearingAccount(arrangement({ openingBalance: null, openingAsOf: null }), [mv('2026-07-02', 'receipt', '1000'), mv('2026-07-03', 'settlement', '400')]);
    expect(summary).toMatchObject({ amountOwed: usd('525'), amountOwedStatus: 'provisional', openingBalance: null, openingBalanceAsOf: null });
    expect(summary.explanation.missing).toContain('Opening balance is unknown: the amount owed reflects recorded movements only');
    expect(exceptions.map((e) => e.dedupeKey)).toEqual([`missing_information:arrangement:${uuid(1)}:opening_balance`]);
    const nothing = computeClearingAccount(arrangement({ openingBalance: null, openingAsOf: null }), []);
    expect(nothing.summary).toMatchObject({ amountOwed: null, amountOwedStatus: 'insufficient_data' });
    expect(ClearingAccountSummary.parse(nothing.summary)).toEqual(nothing.summary);
  });

  it('holds receipts when the fee rate or currency is unknown and flags missing data', () => {
    const { summary, exceptions } = computeClearingAccount(arrangement({ feeRate: null, feeRecipientEntityId: null }), [mv('2026-07-02', 'receipt', '100'), mv('2026-07-03', 'settlement', '50', 'EUR')]);
    expect(summary.movements.map((m) => [m.status, m.effectOnOwed])).toEqual([
      ['held', null],
      ['held', null],
    ]);
    expect(summary).toMatchObject({ amountOwed: usd('500'), amountOwedStatus: 'provisional', heldForClassification: usd('100') });
    expect(exceptions.map((e) => e.dedupeKey.split(':').slice(3).join(':'))).toEqual([expect.stringMatching(/^currency:/), 'fee_rate']);
    // Recognised fee income without a recipient is flagged.
    const noRecipient = computeClearingAccount(arrangement({ feeRecipientEntityId: null }), [mv('2026-07-02', 'receipt', '100')]);
    expect(noRecipient.exceptions.map((e) => e.dedupeKey)).toEqual([`missing_information:arrangement:${uuid(1)}:fee_recipient`]);
  });

  it('notes a negative balance and rejects malformed movements', () => {
    const { summary } = computeClearingAccount(arrangement(), [mv('2026-07-02', 'settlement', '600')]);
    expect(summary.amountOwed).toEqual(usd('-100'));
    expect(summary.explanation.assumptions).toContain('The balance is negative: Third Party A owes 100 USD');
    expect(() => computeClearingAccount(arrangement(), [mv('2026-07-02', 'card_spend', '-5')])).toThrow(ThirdPartyError);
    expect(() => computeClearingAccount(arrangement(), [mv('2026-07-02', 'adjustment', '0')])).toThrow(ThirdPartyError);
    expect(() => computeClearingAccount(arrangement({ feeRate: '1.5' }), [])).toThrow(ThirdPartyError);
  });
});

describe('attributableThirdPartyBalance', () => {
  const business = { id: 'acc-business', name: 'Example Holdings operating', legalEntityId: HOLDER, economicOwnerEntityId: HOLDER, value: usd('8000') };
  const theirs = { id: 'acc-theirs', name: 'Held sub-account', legalEntityId: 'ent-owner', economicOwnerEntityId: THIRD, value: usd('2500') };
  const mine = { id: 'acc-mine', name: 'Owner current', legalEntityId: 'ent-owner', economicOwnerEntityId: 'ent-owner', value: usd('900') };
  const arrangements = [
    { arrangementId: 'arr-1', thirdPartyEntityId: THIRD, thirdPartyName: 'Third Party A', holderEntityId: HOLDER, holdingAccountId: 'acc-business', amountOwed: usd('1200') },
    { arrangementId: 'arr-2', thirdPartyEntityId: THIRD, thirdPartyName: 'Third Party A', holderEntityId: 'ent-owner', holdingAccountId: 'acc-theirs', amountOwed: usd('300') },
    { arrangementId: 'arr-3', thirdPartyEntityId: 'ent-tp-b', thirdPartyName: 'Third Party B', holderEntityId: HOLDER, holdingAccountId: 'acc-business', amountOwed: usd('-50') },
    { arrangementId: 'arr-4', thirdPartyEntityId: 'ent-tp-c', thirdPartyName: 'Third Party C', holderEntityId: HOLDER, holdingAccountId: null, amountOwed: null },
    { arrangementId: 'arr-5', thirdPartyEntityId: 'ent-tp-d', thirdPartyName: 'Third Party D', holderEntityId: HOLDER, holdingAccountId: null, amountOwed: usd('0') },
  ];

  it('excludes whole third-party accounts and clearing balances, never twice', () => {
    const result = attributableThirdPartyBalance([business, theirs, mine], arrangements);
    expect(result.items.map((i) => [i.basis, i.accountId, i.arrangementId, i.amount?.amount ?? null])).toEqual([
      ['whole_account', 'acc-theirs', null, '2500'],
      ['clearing_liability', 'acc-business', 'arr-1', '1200'],
      ['clearing_liability', null, 'arr-4', null],
    ]);
    expect(result.totals).toEqual([usd('3700')]);
    expect(result.unknownCount).toBe(1);
    expect(result.wholeAccountIds).toEqual(['acc-theirs']);
    expect(result.explanation.assumptions).toEqual([
      'Third Party A: clearing balance sits in an account already excluded in full; not counted twice',
      'Third Party B owes the holder 50; that is a receivable, not third-party money',
      'Nothing is currently owed to Third Party D',
    ]);
    expect(attributableForAccount(result, 'acc-business')).toEqual({ amounts: [usd('1200')], unknown: false, wholeAccount: false });
    expect(attributableForAccount(result, 'acc-theirs')).toEqual({ amounts: [usd('2500')], unknown: false, wholeAccount: true });
    expect(attributableForAccount(result, 'acc-mine')).toEqual({ amounts: [], unknown: false, wholeAccount: false });
  });

  it('never infers third-party ownership without an entity link, and keeps unknown values unknown', () => {
    const unknownValue = { ...theirs, value: null };
    const viaEntities = attributableThirdPartyBalance([unknownValue, mine], [], {
      entities: [{ id: THIRD, name: 'Third Party A', kind: 'third_party', ownerControlled: false, primaryOwner: false }],
    });
    expect(viaEntities.items).toHaveLength(1);
    expect(viaEntities.items[0]).toMatchObject({ amount: null, note: 'Whole account belongs to a third party; its value is unknown' });
    expect(viaEntities.totals).toEqual([]);
    expect(viaEntities.unknownCount).toBe(1);
    expect(attributableForAccount(viaEntities, 'acc-theirs')).toEqual({ amounts: [], unknown: true, wholeAccount: true });
    expect(attributableThirdPartyBalance([theirs, mine], []).items).toEqual([]);
    expect(attributableThirdPartyBalance([theirs], [], { thirdPartyEntityIds: [THIRD] }).totals).toEqual([usd('2500')]);
  });
});
