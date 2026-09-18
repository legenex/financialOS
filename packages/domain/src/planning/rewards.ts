/**
 * Card rewards comparison from owner-entered, dated product terms and the owner's CURRENT spending.
 * It never suggests spending more, never ranks products as a recommendation, and never opens anything.
 *
 *   annual spend    = monthly spend × 12 (converted to the home currency)
 *   annual rewards  = spend × cashback % / 100, or spend × points per unit × point value
 *   annual FX costs = non-home-currency spend × FX fee % / 100
 *   annual fees     = annual fee + spend × payment fee % / 100
 *   net             = rewards − fees − FX costs
 */
import type { Money, RewardComparisonInput, RewardComparisonResult, RewardProduct } from '@financialos/contracts';
import { addMonths, type IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { D, dec, money, roundToCurrency, type Dec } from '../money';
import { convertOrNull } from './shared';

export interface RewardComparisonOptions {
  asOf: IsoDate;
  fx: FxTable;
  /** Terms older than this many months are flagged as stale (default 12). */
  staleAfterMonths?: number;
}

export const REWARD_CAVEATS = [
  'Based on your current spending only. This comparison never suggests spending more to earn rewards.',
  'Terms are the ones you entered, with their dates; issuers change terms, so check them before relying on this.',
  'Payment fees are only included where you entered them.',
  'Nothing here applies for a card or opens an account.',
] as const;

export function compareRewards(input: RewardComparisonInput, products: readonly RewardProduct[], options: RewardComparisonOptions): RewardComparisonResult {
  const home = input.homeCurrency;
  const caveats: string[] = [...REWARD_CAVEATS];
  const staleMonths = options.staleAfterMonths ?? 12;
  const toHome = (value: Money): Money | null => convertOrNull(value, home, options.asOf, options.fx).value;

  let total: Dec | null = new D(0);
  let foreign: Dec | null = new D(0);
  for (const line of input.monthlySpend) {
    const annual = money(dec(line.amount).times(12), line.currency);
    const converted = toHome(annual);
    if (converted === null) {
      caveats.push(`Spending in ${line.currency} (${line.category}) could not be converted to ${home}, so totals are unknown.`);
      total = null;
      foreign = null;
      continue;
    }
    if (total !== null) total = total.plus(dec(converted.amount));
    if (foreign !== null && line.currency !== home) foreign = foreign.plus(dec(converted.amount));
  }
  if (!input.paysFullBalance) {
    caveats.push('You do not always pay the full balance: interest charges typically cost more than any rewards earned.');
  }

  const rows: RewardComparisonResult['rows'] = [];
  for (const productId of input.productIds) {
    const product = products.find((p) => p.id === productId);
    if (!product) {
      caveats.push('One selected product has no saved terms and was left out.');
      continue;
    }
    const warnings: string[] = [];
    if (addMonths(product.termsAsOf, staleMonths) < options.asOf) {
      warnings.push(`Terms are more than ${staleMonths} months old (as of ${product.termsAsOf}); treat them as stale and check the current terms.`);
    }
    if (!input.paysFullBalance) warnings.push('Interest on a carried balance typically exceeds the rewards shown.');

    let rewards: Dec | null = null;
    if (product.earnRate === null) warnings.push('Earn rate not entered, so rewards cannot be calculated.');
    else if (total !== null) {
      if (product.earnUnit === 'cashback_percent') rewards = total.times(dec(product.earnRate)).dividedBy(100);
      else if (product.pointValue === null) warnings.push('Point value not set, so points cannot be valued.');
      else {
        const pointValue = toHome(product.pointValue);
        if (pointValue === null) warnings.push(`Point value could not be converted to ${home}.`);
        else rewards = total.times(dec(product.earnRate)).times(dec(pointValue.amount));
      }
    }

    let fees: Dec | null = null;
    if (product.annualFee === null) warnings.push('Annual fee not entered.');
    else {
      const fee = toHome(product.annualFee);
      if (fee === null) warnings.push(`Annual fee could not be converted to ${home}.`);
      else if (total !== null) {
        fees = dec(fee.amount);
        if (product.paymentFeePercent !== null) fees = fees.plus(total.times(dec(product.paymentFeePercent)).dividedBy(100));
      }
    }

    let fxCosts: Dec | null = null;
    if (foreign !== null) {
      if (foreign.isZero()) fxCosts = new D(0);
      else if (product.fxFeePercent === null) warnings.push('FX fee not entered, so the cost of foreign-currency spending is unknown.');
      else fxCosts = foreign.times(dec(product.fxFeePercent)).dividedBy(100);
    }

    const round = (value: Dec | null) => (value === null ? null : roundToCurrency(money(value, home)));
    const annualRewards = round(rewards);
    const annualFees = round(fees);
    const annualFxCosts = round(fxCosts);
    const net =
      annualRewards && annualFees && annualFxCosts
        ? roundToCurrency(money(dec(annualRewards.amount).minus(dec(annualFees.amount)).minus(dec(annualFxCosts.amount)), home))
        : null;
    rows.push({
      productId: product.id,
      name: product.name,
      termsAsOf: product.termsAsOf,
      annualRewards,
      annualFees,
      annualFxCosts,
      netAnnualValue: net,
      warnings,
    });
  }
  return { rows, caveats };
}
