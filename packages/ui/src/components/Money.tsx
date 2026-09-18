import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { decimalSign, formatMoneyValue, isKnownMoney, MASKED_TEXT, type MaybeMoneyValue, type MoneyValue } from '../lib/money';
import { usePrivacy } from '../lib/privacy';
import { Tooltip } from './Tooltip';

export interface MoneyProps {
  /** Money from the API. `null`, or an amount of `null`, means unknown — never shown as zero. */
  value: MoneyValue | MaybeMoneyValue | null | undefined;
  /** Why the value is unknown (shown in a tooltip and to screen readers). */
  unknownReason?: string;
  /** Text for unknown values. */
  unknownLabel?: string;
  /** Prefix with ≈ and say "approximately" to assistive technology. */
  approximate?: boolean;
  /** Show + for positive values. */
  signed?: boolean;
  /** Colour by sign (positive/negative). Off by default: most amounts are neutral. */
  tone?: 'none' | 'sign' | 'inverse';
  /** Round to whole units (e.g. dense lists and headlines). */
  wholeUnits?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'figure';
  weight?: 'regular' | 'medium' | 'semibold';
  /** Force masking regardless of the privacy toggle (e.g. previews). */
  masked?: boolean;
  className?: string;
  /** Tabular figures for columns (default true). Hero figures should pass false. */
  tabular?: boolean;
  suffix?: ReactNode;
}

/**
 * Renders a decimal-string amount. Honours the global privacy mask, keeps unknown values explicit, and never
 * converts the amount to a JS number.
 */
export function Money({
  value,
  unknownReason,
  unknownLabel = 'Unknown',
  approximate,
  signed,
  tone = 'none',
  wholeUnits,
  size = 'md',
  weight = 'regular',
  masked: forceMasked,
  className,
  tabular = true,
  suffix,
}: MoneyProps) {
  const { masked: privacyMasked } = usePrivacy();
  const masked = forceMasked ?? privacyMasked;
  const base = cx('fos-money', `fos-money--${size}`, `fos-money--w-${weight}`, tabular && 'fos-num', className);

  if (!isKnownMoney(value)) {
    const reason = unknownReason ?? 'This amount has not been provided or could not be determined.';
    return (
      <Tooltip content={reason}>
        <span className={cx(base, 'fos-money--unknown')} tabIndex={0} data-unknown="true">
          {unknownLabel}
          <span className="fos-sr-only">: {reason}</span>
        </span>
      </Tooltip>
    );
  }

  if (masked) {
    return (
      <span className={cx(base, 'fos-money--masked')} data-masked="true">
        <span aria-hidden="true">{MASKED_TEXT}</span>
        <span className="fos-sr-only">Amount hidden</span>
      </span>
    );
  }

  const sign = decimalSign(value.amount);
  const text = formatMoneyValue(value, { signed, wholeUnits });
  const toneClass =
    tone === 'none' || sign === 0
      ? undefined
      : (tone === 'sign' ? sign > 0 : sign < 0)
        ? 'fos-money--positive'
        : 'fos-money--negative';
  return (
    <span className={cx(base, toneClass)}>
      {approximate && (
        <>
          <span aria-hidden="true">≈&#8201;</span>
          <span className="fos-sr-only">approximately </span>
        </>
      )}
      {text}
      {suffix}
    </span>
  );
}
