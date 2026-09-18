import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { money } from '../money';
import { confirmTransferMatch, EMPTY_TRANSFER_STATE, matchTransfers, rejectTransferMatch, type TransferMatchState } from './transfers';
import type { AccountInfo, EntityInfo, TransactionLike } from './types';

const entities: EntityInfo[] = [
  { id: 'owner', name: 'Sample Owner', kind: 'person', ownerControlled: true, primaryOwner: true },
  { id: 'company', name: 'Example Holdings Ltd', kind: 'company', ownerControlled: true, primaryOwner: false },
  { id: 'outside', name: 'Third Party A', kind: 'third_party', ownerControlled: false, primaryOwner: false },
];

function account(id: string, name: string, owner: string, currency: string, masked: string | null = null): AccountInfo {
  return {
    id,
    name,
    kind: 'current',
    currency,
    legalEntityId: owner,
    economicOwnerEntityId: owner,
    ownershipConfirmed: true,
    liquidityClass: 'cash',
    includeInSafeToSpend: owner === 'owner',
    status: 'active',
    maskedIdentifier: masked,
  };
}

const accounts: AccountInfo[] = [
  account('a-usd', 'Everyday USD', 'owner', 'USD', '****1111'),
  account('a-sav', 'Rainy Day Savings', 'owner', 'USD', '****2222'),
  account('a-zar', 'Home ZAR', 'owner', 'ZAR'),
  account('a-eur', 'Travel EUR', 'owner', 'EUR'),
  account('c-usd', 'Company Operating', 'company', 'USD'),
  account('x-usd', 'Outside Wallet', 'outside', 'USD'),
];

const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18.40', asOf: '2026-06-01', source: 'test-feed' }]);

function t(id: string, accountId: string, bookedOn: string, amount: string, currency: string, description: string, over: Partial<TransactionLike> = {}): TransactionLike {
  return { id, accountId, bookedOn, amount: money(amount, currency), description, status: 'posted', ...over };
}

describe('matchTransfers', () => {
  it('matches equal same-currency amounts with high confidence and an explanation', () => {
    const result = matchTransfers(
      [t('o1', 'a-usd', '2026-06-02', '-500', 'USD', 'Transfer to Rainy Day Savings'), t('i1', 'a-sav', '2026-06-02', '500', 'USD', 'Incoming from 1111')],
      accounts,
      entities,
    );
    expect(result.suggestions).toHaveLength(1);
    const s = result.suggestions[0]!;
    expect(s).toMatchObject({ outflowId: 'o1', inflowId: 'i1', score: 100, confidence: 'high', status: 'suggested', sameCurrency: true, fee: null, dayGap: 0 });
    expect(s.explanation).toEqual([
      'Equal amounts (500 USD)',
      'Same day',
      'Description suggests a transfer ("transfer")',
      'Description mentions account "Rainy Day Savings"',
      'Both accounts have the same economic owner',
    ]);
  });

  it('reports a fee when the inflow is smaller within tolerance', () => {
    const txs = [t('o1', 'a-usd', '2026-06-02', '-500', 'USD', 'Payment out'), t('i1', 'a-sav', '2026-06-03', '498.50', 'USD', 'Payment in')];
    const s = matchTransfers(txs, accounts, entities).suggestions[0]!;
    expect(s).toMatchObject({ fee: money('1.5', 'USD'), score: 65, confidence: 'medium', dayGap: 1 });
    expect(s.explanation[0]).toBe('Inflow is 1.5 USD less than the outflow; treated as a fee within tolerance (10)');
    const tooBig = [txs[0]!, t('i2', 'a-sav', '2026-06-03', '480', 'USD', 'Payment in')];
    expect(matchTransfers(tooBig, accounts, entities).suggestions).toEqual([]);
    expect(matchTransfers(tooBig, accounts, entities, EMPTY_TRANSFER_STATE, { feeToleranceAbsolute: { USD: '25' } }).suggestions[0]!.fee).toEqual(money('20', 'USD'));
    const bigger = [txs[0]!, t('i3', 'a-sav', '2026-06-03', '500.01', 'USD', 'Payment in')];
    expect(matchTransfers(bigger, accounts, entities).suggestions).toEqual([]);
  });

  it('checks cross-currency pairs against the reference rate', () => {
    const out = t('o1', 'a-usd', '2026-06-03', '-100', 'USD', 'FX exchange');
    const s = matchTransfers([out, t('i1', 'a-zar', '2026-06-03', '1834.50', 'ZAR', 'Exchange credit')], accounts, entities, EMPTY_TRANSFER_STATE, { fx }).suggestions[0]!;
    expect(s).toMatchObject({ sameCurrency: false, impliedRate: '18.345', referenceRate: '18.4', rateDeviation: '0.002989', score: 90, confidence: 'high', fee: null });
    expect(s.explanation[0]).toBe('Implied rate 18.345 USD/ZAR is 0.299% from the reference 18.4 (test-feed, 2026-06-01)');
    const off = matchTransfers([out, t('i2', 'a-zar', '2026-06-03', '1700', 'ZAR', 'Exchange credit')], accounts, entities, EMPTY_TRANSFER_STATE, { fx });
    expect(off.suggestions).toEqual([]);
    const loose = matchTransfers([out, t('i2', 'a-zar', '2026-06-03', '1700', 'ZAR', 'Exchange credit')], accounts, entities, EMPTY_TRANSFER_STATE, { fx, fxTolerance: '0.1' });
    expect(loose.suggestions[0]!.rateDeviation).toBe('0.076087');
    expect(loose.suggestions[0]!.score).toBe(80);
  });

  it('caps confidence at low when no reference rate exists', () => {
    const s = matchTransfers(
      [t('o1', 'a-usd', '2026-06-03', '-100', 'USD', 'Transfer to Travel EUR'), t('i1', 'a-eur', '2026-06-03', '91.20', 'EUR', 'Transfer in')],
      accounts,
      entities,
      EMPTY_TRANSFER_STATE,
      { fx, autoConfirm: true },
    ).suggestions[0]!;
    expect(s.score).toBe(60);
    expect(s.confidence).toBe('low');
    expect(s.status).toBe('suggested');
    expect(s.referenceRate).toBeNull();
    expect(s.explanation).toContain('Confidence capped at low because the exchange rate could not be verified');
  });

  it('raises the score for description hints and related owners', () => {
    const plain = matchTransfers([t('o', 'a-usd', '2026-06-02', '-75', 'USD', 'Payment'), t('i', 'c-usd', '2026-06-02', '75', 'USD', 'Deposit')], accounts, entities).suggestions[0]!;
    const hinted = matchTransfers([t('o', 'a-usd', '2026-06-02', '-75', 'USD', 'Own account transfer'), t('i', 'c-usd', '2026-06-02', '75', 'USD', 'Deposit')], accounts, entities).suggestions[0]!;
    const unrelated = matchTransfers([t('o', 'a-usd', '2026-06-02', '-75', 'USD', 'Payment'), t('i', 'x-usd', '2026-06-02', '75', 'USD', 'Deposit')], accounts, entities).suggestions[0]!;
    expect(plain.score).toBe(80);
    expect(plain.explanation).toContain('Both accounts belong to the same owner group');
    expect(hinted.score).toBe(90);
    expect(unrelated.score).toBe(70);
    expect(unrelated.explanation).toContain('Accounts belong to unrelated or unknown owners');
    // Words inside other words are not hints.
    const embedded = matchTransfers([t('o', 'a-usd', '2026-06-02', '-75', 'USD', 'Effxort Transferable Goods'), t('i', 'c-usd', '2026-06-02', '75', 'USD', 'Deposit')], accounts, entities).suggestions[0]!;
    expect(embedded.score).toBe(80);
  });

  it('assigns one-to-one by best score', () => {
    const result = matchTransfers(
      [t('o-far', 'a-usd', '2026-06-04', '-500', 'USD', 'Payment'), t('o-near', 'a-usd', '2026-06-01', '-500', 'USD', 'Payment'), t('i1', 'a-sav', '2026-06-01', '500', 'USD', 'Deposit')],
      accounts,
      entities,
    );
    expect(result.suggestions.map((s) => [s.outflowId, s.inflowId])).toEqual([['o-near', 'i1']]);
    expect(result.suggestions[0]!.explanation.some((e) => e.startsWith('Ambiguous'))).toBe(false);
  });

  it('never re-suggests a rejected pair', () => {
    const txs = [t('o-far', 'a-usd', '2026-06-04', '-500', 'USD', 'Payment'), t('o-near', 'a-usd', '2026-06-01', '-500', 'USD', 'Payment'), t('i1', 'a-sav', '2026-06-01', '500', 'USD', 'Deposit')];
    const first = matchTransfers(txs, accounts, entities);
    const state = rejectTransferMatch(EMPTY_TRANSFER_STATE, first.suggestions[0]!);
    expect(state.rejected).toEqual([{ outflowId: 'o-near', inflowId: 'i1' }]);
    const second = matchTransfers(txs, accounts, entities, state);
    expect(second.skippedRejected).toBe(1);
    expect(second.suggestions.map((s) => [s.outflowId, s.inflowId])).toEqual([['o-far', 'i1']]);
    const both = rejectTransferMatch(state, second.suggestions[0]!);
    expect(rejectTransferMatch(both, second.suggestions[0]!).rejected).toHaveLength(2);
    const third = matchTransfers(txs, accounts, entities, both);
    expect(third.suggestions).toEqual([]);
    expect(third.skippedRejected).toBe(2);
    expect(EMPTY_TRANSFER_STATE.rejected).toEqual([]);
  });

  it('auto-confirms only above the threshold and without close competitors', () => {
    const clear = matchTransfers(
      [t('o1', 'a-usd', '2026-06-02', '-500', 'USD', 'Transfer to Rainy Day Savings'), t('i1', 'a-sav', '2026-06-02', '500', 'USD', 'Transfer in')],
      accounts,
      entities,
      EMPTY_TRANSFER_STATE,
      { autoConfirm: true },
    ).suggestions[0]!;
    expect(clear.status).toBe('confirmed');
    expect(clear.explanation.at(-1)).toBe('Auto-confirmed at high confidence (score 100)');

    const medium = matchTransfers([t('o1', 'a-usd', '2026-06-02', '-500', 'USD', 'Payment'), t('i1', 'a-sav', '2026-06-04', '499', 'USD', 'Deposit')], accounts, entities, EMPTY_TRANSFER_STATE, {
      autoConfirm: true,
    }).suggestions[0]!;
    expect(medium.confidence).toBe('medium');
    expect(medium.status).toBe('suggested');
    expect(medium.explanation.at(-1)).toBe('Not auto-confirmed: confidence medium is below high');
    const mediumAllowed = matchTransfers([t('o1', 'a-usd', '2026-06-02', '-500', 'USD', 'Payment'), t('i1', 'a-sav', '2026-06-04', '499', 'USD', 'Deposit')], accounts, entities, EMPTY_TRANSFER_STATE, {
      autoConfirm: true,
      autoConfirmThreshold: 'medium',
    }).suggestions[0]!;
    expect(mediumAllowed.status).toBe('confirmed');

    const ambiguous = matchTransfers(
      [t('o1', 'a-usd', '2026-06-02', '-500', 'USD', 'Transfer out'), t('i1', 'a-sav', '2026-06-02', '500', 'USD', 'Transfer in'), t('i2', 'c-usd', '2026-06-02', '500', 'USD', 'Transfer in')],
      accounts,
      entities,
      EMPTY_TRANSFER_STATE,
      { autoConfirm: true, ambiguityMargin: 10 },
    );
    expect(ambiguous.suggestions).toHaveLength(1);
    expect(ambiguous.suggestions[0]!.status).toBe('suggested');
    expect(ambiguous.suggestions[0]!.explanation).toContain('Not auto-confirmed: a competing candidate is too close');
  });

  it('skips confirmed transactions and keeps confirmation state consistent', () => {
    const txs = [t('o1', 'a-usd', '2026-06-02', '-500', 'USD', 'Payment'), t('i1', 'a-sav', '2026-06-02', '500', 'USD', 'Deposit')];
    const rejected = rejectTransferMatch(EMPTY_TRANSFER_STATE, { outflowId: 'o1', inflowId: 'i1' });
    const confirmed: TransferMatchState = confirmTransferMatch(rejected, { outflowId: 'o1', inflowId: 'i1' });
    expect(confirmed).toEqual({ confirmed: [{ outflowId: 'o1', inflowId: 'i1' }], rejected: [] });
    expect(confirmTransferMatch(confirmed, { outflowId: 'o1', inflowId: 'i1' }).confirmed).toHaveLength(1);
    expect(matchTransfers(txs, accounts, entities, confirmed).suggestions).toEqual([]);
    expect(() => confirmTransferMatch(confirmed, { outflowId: 'o1', inflowId: 'i9' })).toThrow(/already confirmed/);
    expect(rejectTransferMatch(confirmed, { outflowId: 'o1', inflowId: 'i1' })).toEqual({ confirmed: [], rejected: [{ outflowId: 'o1', inflowId: 'i1' }] });
  });

  it('respects the date window, account identity, status and unknown accounts', () => {
    const out = t('o1', 'a-usd', '2026-06-01', '-500', 'USD', 'Payment');
    expect(matchTransfers([out, t('i1', 'a-sav', '2026-06-07', '500', 'USD', 'x')], accounts, entities).suggestions).toEqual([]);
    expect(matchTransfers([out, t('i1', 'a-sav', '2026-06-07', '500', 'USD', 'x')], accounts, entities, EMPTY_TRANSFER_STATE, { windowDays: 6 }).suggestions[0]!.score).toBe(70);
    expect(matchTransfers([out, t('i1', 'a-sav', '2026-05-31', '500', 'USD', 'x')], accounts, entities).suggestions[0]!.dayGap).toBe(-1);
    expect(matchTransfers([out, t('i1', 'a-usd', '2026-06-01', '500', 'USD', 'x')], accounts, entities).suggestions).toEqual([]);
    const pending = t('i1', 'a-sav', '2026-06-01', '500', 'USD', 'x', { status: 'pending' });
    expect(matchTransfers([out, pending], accounts, entities).suggestions).toEqual([]);
    expect(matchTransfers([out, pending], accounts, entities, EMPTY_TRANSFER_STATE, { includePending: true }).suggestions).toHaveLength(1);
    expect(matchTransfers([out, t('i1', 'a-sav', '2026-06-01', '500', 'USD', 'x', { status: 'reversed' })], accounts, entities).suggestions).toEqual([]);
    expect(matchTransfers([out, t('i1', 'unknown', '2026-06-01', '500', 'USD', 'x')], accounts, entities).suggestions).toEqual([]);
    expect(matchTransfers([t('z', 'a-usd', '2026-06-01', '0', 'USD', 'x'), t('i1', 'a-sav', '2026-06-01', '0', 'USD', 'x')], accounts, entities).suggestions).toEqual([]);
  });
});
