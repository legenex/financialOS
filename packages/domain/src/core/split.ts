/**
 * Exact splitting of an amount into parts. Fixed parts take their stated magnitude; weighted parts share the
 * remainder with the largest-remainder method (`allocate`), so the parts always sum exactly to the total.
 * Shared by the ledger split builder and classification split templates.
 */
import type { Money } from '@financialos/contracts';
import { allocate, D, dec, hasValidPrecision, money, MoneyError, type Dec } from '../money';

export class SplitError extends MoneyError {
  override name = 'SplitError';
}

/** `weight`: share of the remainder after fixed parts. `fixed`: a non-negative magnitude; its sign follows the total. */
export type SplitShare = { kind: 'weight'; weight: string } | { kind: 'fixed'; amount: string };

/**
 * Splits `total` into one part per share, in order. Throws SplitError when the shares cannot cover the total
 * exactly (fixed parts exceed it, or there is a remainder but no weighted part to absorb it).
 */
export function splitAmount(total: Money, shares: readonly SplitShare[]): Money[] {
  if (shares.length === 0) throw new SplitError('A split needs at least one part');
  if (!hasValidPrecision(total)) throw new SplitError(`${total.amount} ${total.currency} exceeds the currency precision`);
  const totalDec = dec(total.amount);
  const sign = totalDec.isNegative() ? -1 : 1;
  const magnitude = totalDec.abs();

  let fixedSum: Dec = new D(0);
  const weights: Dec[] = [];
  shares.forEach((share, index) => {
    if (share.kind === 'fixed') {
      const amount = dec(share.amount);
      if (amount.isNegative()) throw new SplitError(`Split part ${index + 1}: fixed amounts are magnitudes and must not be negative`);
      if (!hasValidPrecision(money(amount, total.currency))) {
        throw new SplitError(`Split part ${index + 1}: ${share.amount} exceeds ${total.currency} precision`);
      }
      fixedSum = fixedSum.plus(amount);
    } else {
      const weight = dec(share.weight);
      if (weight.isNegative()) throw new SplitError(`Split part ${index + 1}: weights must not be negative`);
      weights.push(weight);
    }
  });

  if (fixedSum.greaterThan(magnitude)) {
    throw new SplitError(`Fixed split parts (${fixedSum.toFixed()}) exceed the total (${magnitude.toFixed()} ${total.currency})`);
  }
  const remainder = magnitude.minus(fixedSum);
  const weightSum = weights.reduce((acc, w) => acc.plus(w), new D(0));

  let allocated: Money[] = [];
  if (weights.length === 0) {
    if (!remainder.isZero()) {
      throw new SplitError(`Fixed split parts leave ${remainder.toFixed()} ${total.currency} unallocated and no weighted part absorbs it`);
    }
  } else if (weightSum.isZero()) {
    if (!remainder.isZero()) throw new SplitError('All split weights are zero but a remainder must be allocated');
    allocated = weights.map(() => money('0', total.currency));
  } else {
    allocated = allocate(money(remainder, total.currency), weights);
  }

  let weightIndex = 0;
  return shares.map((share) => {
    const part = share.kind === 'fixed' ? dec(share.amount) : dec(allocated[weightIndex++]!.amount);
    return money(part.times(sign), total.currency);
  });
}

/** Sum of percentages must be exactly 100 for a percent-based template. */
export function percentagesSumTo100(percents: readonly string[]): boolean {
  return percents.reduce((acc, p) => acc.plus(dec(p)), new D(0)).equals(100);
}
