/**
 * Third-party clearing subledger: money the owner (or an owner company) holds for someone else.
 *
 * Effects on the amount owed to the third party (positive increases what is owed):
 * - receipt, `deducted_from_receipt`: fee = round(gross × rate); owed += gross − fee
 * - receipt, `charged_on_top`:        principal = round(gross / (1 + rate)); fee = gross − principal; owed += principal
 * - receipt, `unconfirmed`:           the whole receipt is held (effect null); no fee income is recognised; the
 *                                     amount owed is provisional; both alternative fee incomes are reported
 * - card_spend / transfer_out / settlement: owed −= amount (third-party card spend is not a business expense)
 * - reimbursement: money received for the third party without a fee (e.g. a refund of their card spend):
 *                  owed += amount
 * - adjustment: signed; owed += amount
 * The opening balance is the amount owed at the END of `openingAsOf`; movements dated on or before it are
 * treated as already included and excluded from the running total.
 */
import type { ClearingAccountSummary, ClearingMovement, Explanation, Money, SourceLink, ThirdPartyFeeMode } from '@financialos/contracts';
import type { IsoDate } from '../dates';
import { D, dec, money, roundToCurrency, type Dec, type RoundingMode } from '../money';
import { accountLink, arrangementLink, ExplanationBuilder, exceptionDescriptor, transactionLink } from './explain';
import type { EntityInfo, ExceptionDescriptor } from './types';

export class ThirdPartyError extends Error {
  override name = 'ThirdPartyError';
}

export type ThirdPartyMovementKind = 'receipt' | 'card_spend' | 'transfer_out' | 'reimbursement' | 'settlement' | 'adjustment';

export interface ThirdPartyArrangement {
  id: string;
  thirdPartyEntityId: string;
  thirdPartyName: string;
  currency: string;
  /** Fraction, e.g. "0.075" for 7.5 %. Null = not known. */
  feeRate: string | null;
  feeMode: ThirdPartyFeeMode;
  feeRecipientEntityId: string | null;
  /** Amount owed to the third party at the end of `openingAsOf`. Null = unknown. */
  openingBalance: string | null;
  openingAsOf: IsoDate | null;
  /** Entity holding the money for the third party. */
  holderEntityId: string | null;
  /** Owner-held account where the clearing balance sits, when known. */
  holdingAccountId: string | null;
  /** Rounding of computed fees (default half_even). */
  rounding?: RoundingMode;
}

export interface ThirdPartyMovement {
  id: string;
  date: IsoDate;
  kind: ThirdPartyMovementKind;
  /** Positive magnitude, except `adjustment` where the sign is the effect on the amount owed. */
  amount: Money;
  description: string;
  transactionId: string | null;
  note?: string | null;
}

export interface ThirdPartyClearingResult {
  summary: ClearingAccountSummary;
  exceptions: ExceptionDescriptor[];
}

function parseRate(rate: string): Dec {
  const value = dec(rate);
  if (value.isNegative() || !value.lessThan(1)) throw new ThirdPartyError(`Fee rate ${rate} must be at least 0 and below 1`);
  return value;
}

/** deducted_from_receipt: fee = round(gross × rate); net = gross − fee. */
export function feeDeductedFromReceipt(gross: Money, rate: string, rounding: RoundingMode = 'half_even'): { fee: Money; net: Money } {
  const fee = roundToCurrency(money(dec(gross.amount).times(parseRate(rate)), gross.currency), rounding);
  return { fee, net: money(dec(gross.amount).minus(dec(fee.amount)), gross.currency) };
}

/** charged_on_top: principal = round(gross / (1 + rate)); fee = gross − principal. */
export function feeChargedOnTop(gross: Money, rate: string, rounding: RoundingMode = 'half_even'): { fee: Money; principal: Money } {
  const principal = roundToCurrency(money(dec(gross.amount).dividedBy(parseRate(rate).plus(1)), gross.currency), rounding);
  return { principal, fee: money(dec(gross.amount).minus(dec(principal.amount)), gross.currency) };
}

function sortMovements(movements: readonly ThirdPartyMovement[]): ThirdPartyMovement[] {
  return [...movements].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Computes the clearing account summary (contract `ClearingAccountSummary`) and the exceptions it raises. */
export function computeClearingAccount(arrangement: ThirdPartyArrangement, movementList: readonly ThirdPartyMovement[]): ThirdPartyClearingResult {
  const { currency, feeMode } = arrangement;
  const rounding = arrangement.rounding ?? 'half_even';
  const rate = arrangement.feeRate === null ? null : parseRate(arrangement.feeRate);
  const rateText = arrangement.feeRate;
  const opening = arrangement.openingBalance === null ? null : dec(arrangement.openingBalance);
  const subject = { type: 'arrangement', id: arrangement.id, label: arrangement.thirdPartyName };
  const exceptions: ExceptionDescriptor[] = [];
  const links: SourceLink[] = [arrangementLink(arrangement.id, arrangement.thirdPartyName)];
  if (arrangement.holdingAccountId) links.push(accountLink(arrangement.holdingAccountId, 'Holding account'));

  const explain = new ExplanationBuilder(
    `Amount owed to ${arrangement.thirdPartyName}`,
    feeMode === 'charged_on_top'
      ? 'owed = opening + Σ receipts ÷ (1 + rate) + reimbursements − card spend − transfers out − settlements ± adjustments'
      : 'owed = opening + Σ (receipts − fee) + reimbursements − card spend − transfers out − settlements ± adjustments',
  );
  explain.input('Opening balance owed', opening === null ? null : money(opening, currency), {
    note: arrangement.openingAsOf ? `As of the end of ${arrangement.openingAsOf}` : 'Date unknown',
    links,
  });

  let owed: Dec = opening ?? new D(0);
  let applied = 0;
  let held: Dec = new D(0);
  let feeRecognised: Dec = new D(0);
  let feeIfDeducted: Dec = new D(0);
  let feeIfOnTop: Dec = new D(0);
  const movements: ClearingMovement[] = [];

  for (const m of sortMovements(movementList)) {
    const mLinks = m.transactionId ? [transactionLink(m.transactionId, m.description)] : [];
    const amount = dec(m.amount.amount);
    if (arrangement.openingAsOf && m.date <= arrangement.openingAsOf) {
      explain.excluded(`${m.description} (${m.date})`, m.amount, { note: 'Dated on or before the opening balance date; already included in it', links: mLinks });
      continue;
    }
    const base = { id: m.id, date: m.date, kind: m.kind, gross: { ...m.amount }, description: m.description, transactionId: m.transactionId } as const;
    const hold = (note: string): void => {
      movements.push({ ...base, fee: null, effectOnOwed: null, status: 'held', note });
    };
    if (m.amount.currency !== currency) {
      hold(`Movement is in ${m.amount.currency}, arrangement is in ${currency}; needs an explicit conversion before it affects the balance`);
      explain.missing(`${m.description} (${m.date}) is in ${m.amount.currency} and was not applied`, true, { links: mLinks });
      exceptions.push(
        exceptionDescriptor({
          kind: 'missing_information',
          title: 'Third-party movement in another currency',
          detail: `${m.description} on ${m.date} is ${m.amount.amount} ${m.amount.currency}; the ${arrangement.thirdPartyName} arrangement is kept in ${currency}.`,
          subject,
          entityId: arrangement.holderEntityId,
          discriminator: `currency:${m.id}`,
        }),
      );
      continue;
    }
    if (m.kind !== 'adjustment' && !amount.greaterThan(0)) {
      throw new ThirdPartyError(`Movement ${m.id}: amounts are positive magnitudes (only adjustments are signed)`);
    }

    let effect: Dec;
    let fee: Money | null = null;
    let note = m.note ?? null;
    switch (m.kind) {
      case 'receipt': {
        if (rate !== null) {
          feeIfDeducted = feeIfDeducted.plus(dec(feeDeductedFromReceipt(m.amount, rateText!, rounding).fee.amount));
          feeIfOnTop = feeIfOnTop.plus(dec(feeChargedOnTop(m.amount, rateText!, rounding).fee.amount));
        }
        if (feeMode === 'unconfirmed') {
          held = held.plus(amount);
          hold('Fee policy is unconfirmed: the whole receipt is held for classification and no fee income is recognised');
          explain.item({
            label: `${m.description} (${m.date})`,
            value: { ...m.amount },
            role: 'missing',
            note: 'Held until the fee policy is confirmed',
            links: mLinks,
          });
          continue;
        }
        if (rate === null) {
          held = held.plus(amount);
          hold('Fee rate is unknown: the receipt is held');
          explain.missing(`${m.description} (${m.date}) held: fee rate unknown`, true, { links: mLinks });
          continue;
        }
        if (feeMode === 'deducted_from_receipt') {
          const split = feeDeductedFromReceipt(m.amount, rateText!, rounding);
          fee = split.fee;
          effect = dec(split.net.amount);
          note = note ?? `Fee ${split.fee.amount} (${rateText} of ${m.amount.amount}) deducted from the receipt`;
        } else {
          const split = feeChargedOnTop(m.amount, rateText!, rounding);
          fee = split.fee;
          effect = dec(split.principal.amount);
          note = note ?? `Receipt includes a fee of ${split.fee.amount} charged on top of ${split.principal.amount}`;
        }
        feeRecognised = feeRecognised.plus(dec(fee.amount));
        break;
      }
      case 'reimbursement':
        effect = amount;
        break;
      case 'card_spend':
      case 'transfer_out':
      case 'settlement':
        effect = amount.negated();
        break;
      case 'adjustment':
        if (amount.isZero()) throw new ThirdPartyError(`Adjustment ${m.id} must not be zero`);
        effect = amount;
        break;
      default:
        throw new ThirdPartyError(`Unknown movement kind ${String((m as { kind: unknown }).kind)}`);
    }
    owed = owed.plus(effect);
    applied += 1;
    const effectMoney = money(effect, currency);
    movements.push({ ...base, fee, effectOnOwed: effectMoney, status: 'applied', note });
    const label = `${m.kind.replace('_', ' ')}: ${m.description} (${m.date})`;
    if (effect.isNegative()) explain.subtracted(label, money(effect.negated(), currency), { links: mLinks, note });
    else explain.added(label, effectMoney, { links: mLinks, note });
  }

  // Status and amount owed.
  const missingOpening = opening === null;
  let amountOwed: Money | null = money(owed, currency);
  let status: ClearingAccountSummary['amountOwedStatus'] = 'ok';
  if (missingOpening) {
    if (applied === 0) {
      amountOwed = null;
      status = 'insufficient_data';
      explain.missing('Opening balance is unknown and no movements have been applied', true);
    } else {
      status = 'provisional';
      explain.missing('Opening balance is unknown: the amount owed reflects recorded movements only', true);
    }
    exceptions.push(
      exceptionDescriptor({
        kind: 'missing_information',
        title: `Opening balance owed to ${arrangement.thirdPartyName} is unknown`,
        detail: 'Record the amount owed at a known date so the running balance can be trusted.',
        subject,
        entityId: arrangement.holderEntityId,
        discriminator: 'opening_balance',
      }),
    );
  }
  if (held.greaterThan(0) && status === 'ok') status = 'provisional';
  if (held.greaterThan(0)) explain.missing(`${money(held, currency).amount} ${currency} is held for classification and not included`);

  if (feeMode === 'unconfirmed') {
    explain.assume('Fee policy unconfirmed: no fee income recognised; alternatives are shown for information only');
    const alternatives =
      rate === null
        ? 'The fee rate is also unknown.'
        : `If fees are deducted from receipts, fee income would be ${money(feeIfDeducted, currency).amount} ${currency}; if charged on top, ${money(feeIfOnTop, currency).amount} ${currency}.`;
    exceptions.push(
      exceptionDescriptor({
        kind: 'fee_policy_unconfirmed',
        severity: 'warning',
        title: `Confirm the fee policy for ${arrangement.thirdPartyName}`,
        detail: `${money(held, currency).amount} ${currency} of receipts is held until the fee is confirmed as deducted from receipts or charged on top. ${alternatives}`,
        subject,
        entityId: arrangement.holderEntityId,
      }),
    );
  } else if (rate === null) {
    exceptions.push(
      exceptionDescriptor({
        kind: 'missing_information',
        title: `Fee rate for ${arrangement.thirdPartyName} is unknown`,
        detail: 'Receipts are held until the fee rate is recorded.',
        subject,
        entityId: arrangement.holderEntityId,
        discriminator: 'fee_rate',
      }),
    );
  }
  if (feeRecognised.greaterThan(0) && !arrangement.feeRecipientEntityId) {
    explain.missing('Fee income is recognised but its recipient entity is not recorded', true);
    exceptions.push(
      exceptionDescriptor({
        kind: 'missing_information',
        title: 'Fee recipient is not recorded',
        detail: `Fee income of ${money(feeRecognised, currency).amount} ${currency} has no recipient entity.`,
        subject,
        entityId: arrangement.holderEntityId,
        discriminator: 'fee_recipient',
      }),
    );
  }
  if (amountOwed && owed.isNegative()) {
    explain.assume(`The balance is negative: ${arrangement.thirdPartyName} owes ${money(owed.negated(), currency).amount} ${currency}`);
  }
  explain.result('Amount owed', amountOwed, { links });
  if (feeRecognised.greaterThan(0)) explain.result('Fee income recognised', money(feeRecognised, currency));

  const explanation: Explanation = explain.build();
  const summary: ClearingAccountSummary = {
    arrangementId: arrangement.id,
    thirdPartyName: arrangement.thirdPartyName,
    currency,
    feeRate: rateText,
    feeMode,
    feeModeConfirmed: feeMode !== 'unconfirmed',
    feeRecipientEntityId: arrangement.feeRecipientEntityId,
    openingBalance: opening === null ? null : money(opening, currency),
    openingBalanceAsOf: arrangement.openingAsOf,
    amountOwed,
    amountOwedStatus: status,
    heldForClassification: money(held, currency),
    feeIncomeRecognised: money(feeRecognised, currency),
    feeIncomeIfDeducted: feeMode === 'unconfirmed' && rate !== null ? money(feeIfDeducted, currency) : null,
    feeIncomeIfOnTop: feeMode === 'unconfirmed' && rate !== null ? money(feeIfOnTop, currency) : null,
    movements,
    explanation,
  };
  return { summary, exceptions };
}

// ---------------------------------------------------------------------------------------------------------
// Attributable third-party balances
// ---------------------------------------------------------------------------------------------------------

export interface AttributionAccount {
  id: string;
  name: string;
  legalEntityId: string | null;
  economicOwnerEntityId: string | null;
  /** Current value of the account; null = unknown. */
  value: Money | null;
}

export interface AttributionArrangement {
  arrangementId: string;
  thirdPartyEntityId: string;
  thirdPartyName: string;
  holderEntityId: string | null;
  holdingAccountId: string | null;
  /** From `computeClearingAccount`; null = unknown. */
  amountOwed: Money | null;
}

export interface AttributableItem {
  basis: 'whole_account' | 'clearing_liability';
  accountId: string | null;
  arrangementId: string | null;
  thirdPartyEntityId: string;
  /** Entity holding the money (legal holder of the account, or the arrangement holder). */
  holderEntityId: string | null;
  /** Null = unknown. */
  amount: Money | null;
  note: string;
  links: SourceLink[];
}

export interface AttributableThirdPartyResult {
  items: AttributableItem[];
  /** Known attributable amounts per currency. */
  totals: Money[];
  unknownCount: number;
  /** Accounts that belong economically to a third party in full. */
  wholeAccountIds: string[];
  explanation: Explanation;
}

/**
 * Money that belongs to third parties and must be excluded from owner wealth, income and spending capacity:
 * whole accounts whose economic owner is a third party, plus positive clearing liabilities held inside
 * owner-held accounts. A clearing liability held in an account that is already excluded in full is not counted
 * twice. A negative clearing balance (the third party owes the owner) is a receivable, not attributable money.
 */
export function attributableThirdPartyBalance(
  accounts: readonly AttributionAccount[],
  arrangements: readonly AttributionArrangement[],
  options: { entities?: readonly EntityInfo[]; thirdPartyEntityIds?: readonly string[] } = {},
): AttributableThirdPartyResult {
  const thirdParties = new Set<string>([
    ...(options.entities ?? []).filter((e) => e.kind === 'third_party').map((e) => e.id),
    ...arrangements.map((a) => a.thirdPartyEntityId),
    ...(options.thirdPartyEntityIds ?? []),
  ]);
  const explain = new ExplanationBuilder('Money held for third parties', 'attributable = whole third-party accounts + positive clearing balances in owner-held accounts');
  const items: AttributableItem[] = [];
  const whole = new Set<string>();

  for (const account of [...accounts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!account.economicOwnerEntityId || !thirdParties.has(account.economicOwnerEntityId)) continue;
    whole.add(account.id);
    const links = [accountLink(account.id, account.name)];
    const note = account.value ? 'Whole account belongs to a third party' : 'Whole account belongs to a third party; its value is unknown';
    items.push({
      basis: 'whole_account',
      accountId: account.id,
      arrangementId: null,
      thirdPartyEntityId: account.economicOwnerEntityId,
      holderEntityId: account.legalEntityId,
      amount: account.value ? { ...account.value } : null,
      note,
      links,
    });
    explain.excluded(account.name, account.value, { note, links });
  }

  for (const arrangement of [...arrangements].sort((a, b) => (a.arrangementId < b.arrangementId ? -1 : 1))) {
    const links = [arrangementLink(arrangement.arrangementId, arrangement.thirdPartyName)];
    if (arrangement.holdingAccountId) {
      if (whole.has(arrangement.holdingAccountId)) {
        explain.assume(`${arrangement.thirdPartyName}: clearing balance sits in an account already excluded in full; not counted twice`);
        continue;
      }
      links.push(accountLink(arrangement.holdingAccountId, 'Holding account'));
    }
    if (!arrangement.amountOwed) {
      items.push({
        basis: 'clearing_liability',
        accountId: arrangement.holdingAccountId,
        arrangementId: arrangement.arrangementId,
        thirdPartyEntityId: arrangement.thirdPartyEntityId,
        holderEntityId: arrangement.holderEntityId,
        amount: null,
        note: 'Amount owed is unknown',
        links,
      });
      explain.missing(`Amount owed to ${arrangement.thirdPartyName} is unknown`, true, { links });
      continue;
    }
    const owed = dec(arrangement.amountOwed.amount);
    if (!owed.greaterThan(0)) {
      explain.assume(
        owed.isZero()
          ? `Nothing is currently owed to ${arrangement.thirdPartyName}`
          : `${arrangement.thirdPartyName} owes the holder ${money(owed.negated(), arrangement.amountOwed.currency).amount}; that is a receivable, not third-party money`,
      );
      continue;
    }
    const note = arrangement.holdingAccountId ? 'Clearing balance held inside an owner-held account' : 'Clearing balance; holding account not recorded';
    items.push({
      basis: 'clearing_liability',
      accountId: arrangement.holdingAccountId,
      arrangementId: arrangement.arrangementId,
      thirdPartyEntityId: arrangement.thirdPartyEntityId,
      holderEntityId: arrangement.holderEntityId,
      amount: { ...arrangement.amountOwed },
      note,
      links,
    });
    explain.excluded(`Owed to ${arrangement.thirdPartyName}`, arrangement.amountOwed, { note, links });
  }

  const totals = new Map<string, Dec>();
  let unknownCount = 0;
  for (const item of items) {
    if (!item.amount) {
      unknownCount += 1;
      continue;
    }
    totals.set(item.amount.currency, (totals.get(item.amount.currency) ?? new D(0)).plus(dec(item.amount.amount)));
  }
  const totalList = [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, v]) => money(v, c));
  for (const t of totalList) explain.result(`Total attributable (${t.currency})`, t);
  return { items, totals: totalList, unknownCount, wholeAccountIds: [...whole].sort(), explanation: explain.build() };
}

/**
 * Attributable amounts inside one account, per currency, plus whether an unknown amount applies to it.
 * Safe-to-spend and wealth subtract these from the account's balance.
 */
export function attributableForAccount(result: AttributableThirdPartyResult, accountId: string): { amounts: Money[]; unknown: boolean; wholeAccount: boolean } {
  const totals = new Map<string, Dec>();
  let unknown = false;
  for (const item of result.items) {
    if (item.accountId !== accountId) continue;
    if (!item.amount) {
      unknown = true;
      continue;
    }
    totals.set(item.amount.currency, (totals.get(item.amount.currency) ?? new D(0)).plus(dec(item.amount.amount)));
  }
  return {
    amounts: [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, v]) => money(v, c)),
    unknown,
    wholeAccount: result.wholeAccountIds.includes(accountId),
  };
}
