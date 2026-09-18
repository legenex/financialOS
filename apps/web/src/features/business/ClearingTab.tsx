import { useState } from 'react';
import type { ArrangementPolicyInput, ClearingAccountSummary, ThirdPartyFeeMode } from '@financialos/contracts';
import { Badge, Button, Callout, Card, DataList, DateField, Dialog, EmptyState, Money, NumberField, Select, StatusBadge, TextField, useToast } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useEntities } from '../../lib/endpoints';
import { useClearingSummaries, useSetClearingPolicy } from './api';

const FEE_MODE_OPTIONS: Array<{ value: ThirdPartyFeeMode; label: string }> = [
  { value: 'unconfirmed', label: 'Not confirmed yet' },
  { value: 'deducted_from_receipt', label: 'Fee deducted from each receipt' },
  { value: 'charged_on_top', label: 'Fee charged on top (billed separately)' },
];

function PolicyEditor({ arrangement, open, onOpenChange }: { arrangement: ClearingAccountSummary; open: boolean; onOpenChange: (open: boolean) => void }) {
  const entities = useEntities();
  const setPolicy = useSetClearingPolicy();
  const { toast } = useToast();
  const [draft, setDraft] = useState<ArrangementPolicyInput>({
    feeMode: arrangement.feeMode,
    feeRate: arrangement.feeRate,
    feeRecipientEntityId: arrangement.feeRecipientEntityId,
    openingBalance: arrangement.openingBalance?.amount ?? null,
    openingBalanceAsOf: arrangement.openingBalanceAsOf,
    evidenceNote: null,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Fee policy — ${arrangement.thirdPartyName}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={setPolicy.isPending}
            onClick={() =>
              setPolicy.mutate(
                { arrangementId: arrangement.arrangementId, input: draft },
                {
                  onSuccess: () => {
                    toast({ title: 'Policy saved', description: 'Past receipts are being re-applied in the background.', tone: 'success' });
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {setPolicy.isError && <Callout tone="critical">{userMessage(setPolicy.error)}</Callout>}
        <Callout tone="info">Changing this re-applies every past receipt from this third party in the background — nothing is guessed inline.</Callout>
        <Select label="How the fee is charged" value={draft.feeMode} onValueChange={(v) => setDraft((d) => ({ ...d, feeMode: (v as ThirdPartyFeeMode) ?? d.feeMode }))} options={FEE_MODE_OPTIONS} />
        <NumberField label="Fee rate (e.g. 0.029 for 2.9%)" value={draft.feeRate} onValueChange={(v) => setDraft((d) => ({ ...d, feeRate: v }))} />
        <Select
          label="Fee recipient entity (optional)"
          value={draft.feeRecipientEntityId}
          onValueChange={(v) => setDraft((d) => ({ ...d, feeRecipientEntityId: v }))}
          options={(entities.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          placeholder="Not set"
        />
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Opening balance owed (optional)" value={draft.openingBalance} onValueChange={(v) => setDraft((d) => ({ ...d, openingBalance: v }))} />
          <DateField label="As of" value={draft.openingBalanceAsOf ?? ''} onChange={(v) => setDraft((d) => ({ ...d, openingBalanceAsOf: v || null }))} />
        </div>
        <TextField label="Evidence note (optional)" value={draft.evidenceNote ?? ''} onChange={(e) => setDraft((d) => ({ ...d, evidenceNote: e.target.value || null }))} maxLength={500} />
      </div>
    </Dialog>
  );
}

function ArrangementCard({ arrangement }: { arrangement: ClearingAccountSummary }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="font-medium">{arrangement.thirdPartyName}</span>
        <StatusBadge status={arrangement.amountOwedStatus} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!arrangement.feeModeConfirmed && <Badge tone="caution">Fee handling unconfirmed</Badge>}
        <Badge tone="neutral">{FEE_MODE_OPTIONS.find((o) => o.value === arrangement.feeMode)?.label ?? arrangement.feeMode}</Badge>
      </div>
      <div className="flex flex-wrap gap-6">
        <div>
          <p className="text-sm text-ink-3">Owed to them</p>
          <Money value={arrangement.amountOwed} size="lg" unknownReason="Not enough information yet." />
        </div>
        <div>
          <p className="text-sm text-ink-3">Held pending classification</p>
          <Money value={arrangement.heldForClassification} />
        </div>
        <div>
          <p className="text-sm text-ink-3">Fee income recognised</p>
          <Money value={arrangement.feeIncomeRecognised} />
        </div>
      </div>
      {arrangement.movements.length > 0 && (
        <DataList
          label="Recent movements"
          dense
          items={arrangement.movements.slice(0, 5).map((m) => ({
            id: m.id,
            title: m.description,
            subtitle: `${m.kind.replace(/_/g, ' ')} · ${m.date}${m.status === 'held' ? ' · held' : ''}`,
            value: <Money value={m.gross} />,
          }))}
        />
      )}
      <div>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Set fee policy
        </Button>
      </div>
      <PolicyEditor arrangement={arrangement} open={editing} onOpenChange={setEditing} />
    </Card>
  );
}

export function ClearingTab() {
  const clearing = useClearingSummaries();
  return (
    <QueryState
      query={clearing}
      loadingLabel="Loading third-party clearing accounts"
      isEmpty={(list) => list.length === 0}
      empty={<EmptyState title="No third-party clearing accounts" description="These appear once an account is set up as a third party's clearing account." />}
    >
      {(list) => (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((a) => (
            <ArrangementCard key={a.arrangementId} arrangement={a} />
          ))}
        </div>
      )}
    </QueryState>
  );
}
