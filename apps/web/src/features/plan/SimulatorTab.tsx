import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { PurchaseImpactResult } from '@financialos/contracts';
import { Button, Callout, Card, DateField, Money, NumberField, Section, Select, StatusBadge, TextField } from '@financialos/ui';
import { ExplanationDrawer } from '../../components/ExplanationDrawer';
import { userMessage } from '../../lib/api';
import { useAccounts, useCategories, usePurchaseImpact } from '../../lib/endpoints';
import { minorUnits, todayIso, useCurrencyOptions } from './shared';

const VERDICT_LABEL: Record<PurchaseImpactResult['verdict'], { label: string; tone: 'positive' | 'caution' | 'negative' | 'neutral' }> = {
  fits: { label: 'Fits comfortably', tone: 'positive' },
  tight: { label: 'Tight — proceed carefully', tone: 'caution' },
  does_not_fit: { label: "Doesn't fit", tone: 'negative' },
  unknown: { label: 'Not enough data to tell', tone: 'neutral' },
};

export function SimulatorTab() {
  const { options: currencyOptions, defaultCurrency } = useCurrencyOptions();
  const categories = useCategories();
  const accounts = useAccounts();
  const simulate = usePurchaseImpact();
  const [explain, setExplain] = useState(false);

  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso());
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [paymentAccountId, setPaymentAccountId] = useState<string | null>(null);
  const [installments, setInstallments] = useState('1');

  const effectiveCurrency = currency ?? defaultCurrency;
  const valid = amount !== null && Number(amount) > 0 && !!effectiveCurrency && date.length === 10;

  const run = () => {
    if (!valid || amount === null || !effectiveCurrency) return;
    simulate.mutate({
      amount,
      currency: effectiveCurrency,
      date,
      categoryId,
      label: label.trim() || 'Simulated purchase',
      paymentAccountId,
      installments: Math.max(1, Math.min(60, Number(installments) || 1)),
    });
  };

  const result = simulate.data;
  const verdict = result ? VERDICT_LABEL[result.verdict] : null;

  return (
    <div className="flex flex-col gap-6">
      <Callout tone="neutral">
        See what a purchase would change before you make it: safe-to-spend, your budget, reserves, and any commitments it could put at risk. Nothing here
        is saved until you actually spend or record the transaction.
      </Callout>

      <Card className="flex flex-col gap-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="What is it?" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New laptop" maxLength={120} />
          <NumberField label="Amount" value={amount} onValueChange={setAmount} scale={minorUnits(effectiveCurrency)} prefix={effectiveCurrency ?? undefined} required />
          <Select label="Currency" value={effectiveCurrency} onValueChange={setCurrency} options={currencyOptions} />
          <DateField label="Date" value={date} onChange={setDate} required />
          <Select
            label="Category (optional)"
            value={categoryId}
            onValueChange={setCategoryId}
            options={(categories.data ?? []).filter((c) => c.kind === 'expense').map((c) => ({ value: c.id, label: c.name }))}
            placeholder="No category"
          />
          <Select
            label="Pay from (optional)"
            value={paymentAccountId}
            onValueChange={setPaymentAccountId}
            options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
            placeholder="Not decided yet"
          />
          <NumberField label="Instalments" value={installments} onValueChange={(v) => setInstallments(v ?? '1')} scale={0} hint="1–60" />
        </div>
        {simulate.isError && <Callout tone="critical">{userMessage(simulate.error)}</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" leadingIcon={<Sparkles size={16} />} onClick={run} loading={simulate.isPending} disabled={!valid}>
            Simulate
          </Button>
        </div>
      </Card>

      {result && (
        <Section
          title="Impact"
          actions={
            <Button variant="ghost" size="sm" onClick={() => setExplain(true)}>
              How this is calculated
            </Button>
          }
        >
          <div className="flex flex-col gap-5">
            {verdict && <StatusBadge status={result.verdict} label={verdict.label} tone={verdict.tone} />}
            <div className="grid gap-6 sm:grid-cols-2">
              <Card className="flex flex-col gap-2 p-4">
                <span className="text-sm text-ink-3">Safe to spend</span>
                <span className="flex items-center gap-2">
                  <Money value={result.safeToSpendBefore} size="lg" />
                  <span className="text-ink-3">→</span>
                  <Money value={result.safeToSpendAfter} size="lg" weight="semibold" tone="sign" />
                </span>
              </Card>
              <Card className="flex flex-col gap-2 p-4">
                <span className="text-sm text-ink-3">Budget line</span>
                <span className="flex items-center gap-2">
                  <Money value={result.budgetLineBefore} size="lg" />
                  <span className="text-ink-3">→</span>
                  <Money value={result.budgetLineAfter} size="lg" weight="semibold" tone="sign" />
                </span>
              </Card>
            </div>
            {result.reserveShortfallAfter && (
              <Callout tone="warning">
                This would leave a reserve shortfall of <Money value={result.reserveShortfallAfter} weight="medium" />.
              </Callout>
            )}
            {result.commitmentsAtRisk.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Commitments potentially affected</span>
                <ul className="flex flex-col gap-1.5">
                  {result.commitmentsAtRisk.map((c, i) => (
                    <li key={i} className="flex items-center justify-between text-sm">
                      <span>
                        {c.label} — due {c.dueOn}
                      </span>
                      <Money value={c.amount} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.goalsDelayed.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Goals that could be delayed</span>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {result.goalsDelayed.map((g) => (
                    <li key={g.goalId}>
                      {g.name}
                      {g.delayDays !== null ? ` — about ${g.delayDays} day${g.delayDays === 1 ? '' : 's'} later` : ' — timing unclear'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Section>
      )}

      {result && (
        <ExplanationDrawer open={explain} onOpenChange={setExplain} title="How this purchase impact is calculated" explanation={result.explanation} status={result.status} />
      )}
    </div>
  );
}
