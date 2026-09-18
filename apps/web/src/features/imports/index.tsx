import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { AmountMode, ColumnMapping, DateFormat } from '@financialos/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  DateField,
  EmptyState,
  Money,
  NumberField,
  PageHeader,
  Section,
  Select,
  Stepper,
  Switch,
  Table,
  TextField,
  useToast,
} from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { withContext } from '../../lib/context';
import { useAccounts } from '../../lib/endpoints';
import { useCancelImport, useCommitImport, useConfigureImport, useImportBatch, useImportPreview, useUploadImport } from './api';
import { defaultMapping } from './mapping';

const STEPS = [
  { id: 'upload', label: 'Upload' },
  { id: 'configure', label: 'Configure' },
  { id: 'preview', label: 'Preview' },
  { id: 'done', label: 'Commit' },
];

const DATE_FORMAT_OPTIONS: DateFormat[] = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD', 'D MMM YYYY', 'MMM D, YYYY', 'YYYYMMDD', 'excel_serial', 'iso_datetime'];
const AMOUNT_MODE_OPTIONS: Array<{ value: AmountMode; label: string }> = [
  { value: 'signed', label: 'One signed amount column' },
  { value: 'debit_credit', label: 'Separate debit and credit columns' },
  { value: 'amount_direction', label: 'Amount column plus a direction column' },
];

const ROW_STATUS_TONE: Record<string, 'positive' | 'caution' | 'negative' | 'neutral'> = {
  new: 'positive',
  duplicate: 'neutral',
  possible_duplicate: 'caution',
  pending_to_posted: 'neutral',
  changed_upstream: 'caution',
  error: 'negative',
  skipped: 'neutral',
};

function UploadStep({ onUploaded }: { onUploaded: (batchId: string) => void }) {
  const upload = useUploadImport();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Section title="Upload a statement" description="CSV, Excel, OFX/QFX, or an Interactive Brokers Flex report. The file is stored encrypted; nothing is parsed until you confirm the mapping.">
      {upload.isError && <Callout tone="critical">{userMessage(upload.error)}</Callout>}
      <div className="flex flex-col items-start gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,.xlsx,.xls,.ofx,.qfx,.xml,.pdf"
          className="fos-sr-only"
          id="import-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file, { onSuccess: (batch) => onUploaded(batch.id) });
          }}
        />
        <Button variant="primary" loading={upload.isPending} onClick={() => inputRef.current?.click()}>
          Choose a file
        </Button>
      </div>
    </Section>
  );
}

function ConfigureStep({ batchId, onConfigured }: { batchId: string; onConfigured: () => void }) {
  const batch = useImportBatch(batchId);
  const accounts = useAccounts();
  const configure = useConfigureImport();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [openingBalance, setOpeningBalance] = useState<string | null>(null);
  const [closingBalance, setClosingBalance] = useState<string | null>(null);

  if (batch.isLoading || !batch.data) return null;
  const b = batch.data;
  const headers = b.detectedHeaders;
  const current = mapping ?? defaultMapping(headers);
  const set = (patch: Partial<ColumnMapping>) => setMapping({ ...current, ...patch });
  const valid = accountId && current.dateColumn && current.descriptionColumns[0];

  return (
    <div className="flex flex-col gap-6">
      {configure.isError && <Callout tone="critical">{userMessage(configure.error)}</Callout>}
      <Section title={b.fileName} description={`${(b.sizeBytes / 1024).toFixed(0)} KB · detected as ${b.fileKind ?? 'unknown'}`}>
        <Select label="Account" value={accountId} onValueChange={setAccountId} options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }))} placeholder="Choose the account this statement is for" required />
      </Section>

      {headers.length > 0 && (
        <Section title="Column mapping" description="Tell FinancialOS which column is which. Sample rows from the file are shown below each field where useful.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Date column" value={current.dateColumn || null} onValueChange={(v) => v && set({ dateColumn: v })} options={headers.map((h) => ({ value: h, label: h }))} />
            <Select label="Date format" value={current.dateFormat} onValueChange={(v) => v && set({ dateFormat: v as DateFormat })} options={DATE_FORMAT_OPTIONS.map((f) => ({ value: f, label: f }))} />
            <Select label="Description column" value={current.descriptionColumns[0] ?? null} onValueChange={(v) => v && set({ descriptionColumns: [v] })} options={headers.map((h) => ({ value: h, label: h }))} />
            <Select label="Reference column (optional)" value={current.referenceColumn} onValueChange={(v) => set({ referenceColumn: v })} options={headers.map((h) => ({ value: h, label: h }))} placeholder="None" />
            <Select label="Amount mode" value={current.amountMode} onValueChange={(v) => v && set({ amountMode: v as AmountMode })} options={AMOUNT_MODE_OPTIONS} />
            {current.amountMode === 'signed' && (
              <Select label="Amount column" value={current.amountColumn} onValueChange={(v) => set({ amountColumn: v })} options={headers.map((h) => ({ value: h, label: h }))} />
            )}
            {current.amountMode !== 'signed' && (
              <>
                <Select label="Debit column" value={current.debitColumn} onValueChange={(v) => set({ debitColumn: v })} options={headers.map((h) => ({ value: h, label: h }))} />
                <Select label="Credit column" value={current.creditColumn} onValueChange={(v) => set({ creditColumn: v })} options={headers.map((h) => ({ value: h, label: h }))} />
              </>
            )}
            <Select label="Balance column (optional)" value={current.balanceColumn} onValueChange={(v) => set({ balanceColumn: v })} options={headers.map((h) => ({ value: h, label: h }))} placeholder="None" />
            <TextField label="Currency" value={current.defaultCurrency} onChange={(e) => set({ defaultCurrency: e.target.value.toUpperCase() })} maxLength={10} />
          </div>
          <Switch label="Negative amounts are debits (money out)" checked={current.negativeIsDebit} onCheckedChange={(v) => set({ negativeIsDebit: v })} />
          {b.sampleRows.length > 0 && (
            <p className="text-xs text-ink-3">
              First sample row: {headers.map((h, i) => `${h}=${b.sampleRows[0]?.[i] ?? ''}`).join(', ')}
            </p>
          )}
        </Section>
      )}

      <Section title="Statement balances (optional)" description="If the statement states an opening or closing balance, entering it lets FinancialOS check the import reconciles.">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Opening balance" value={openingBalance} onValueChange={setOpeningBalance} allowNegative />
          <NumberField label="Closing balance" value={closingBalance} onValueChange={setClosingBalance} allowNegative />
        </div>
      </Section>

      <div>
        <Button
          variant="primary"
          disabled={!valid}
          loading={configure.isPending}
          onClick={() => {
            if (!accountId) return;
            configure.mutate(
              {
                id: batchId,
                input: {
                  accountId,
                  templateId: null,
                  mapping: current,
                  fileKind: b.fileKind ?? 'csv',
                  saveTemplateAs: null,
                  statementOpening: openingBalance,
                  statementClosing: closingBalance,
                },
              },
              { onSuccess: onConfigured },
            );
          }}
        >
          Parse this statement
        </Button>
      </div>
    </div>
  );
}

function PreviewStep({ batchId, onCommitted }: { batchId: string; onCommitted: () => void }) {
  const batch = useImportBatch(batchId, { poll: true });
  const preview = useImportPreview(batchId, null);
  const commit = useCommitImport();
  const cancel = useCancelImport();
  const { toast } = useToast();
  const [included, setIncluded] = useState<Set<number>>(new Set());

  const b = batch.data;
  if (!b) return null;

  if (b.status === 'parsing') {
    return <Callout tone="info">Parsing the statement in the background…</Callout>;
  }
  if (b.status === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        <Callout tone="critical">{b.error ?? 'The import could not be parsed.'}</Callout>
        <div>
          <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(batchId)}>
            Cancel this import
          </Button>
        </div>
      </div>
    );
  }
  if (b.status !== 'previewed') return null;

  const rows = preview.data ?? [];
  const possibleDuplicates = rows.filter((r) => r.status === 'possible_duplicate');

  return (
    <div className="flex flex-col gap-6">
      <Section title="Reconciliation">
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-sm text-ink-3">New</p>
            <p className="text-lg font-semibold fos-num">{b.counts.new}</p>
          </div>
          <div>
            <p className="text-sm text-ink-3">Duplicates (skipped)</p>
            <p className="text-lg font-semibold fos-num">{b.counts.duplicate}</p>
          </div>
          <div>
            <p className="text-sm text-ink-3">Possible duplicates</p>
            <p className="text-lg font-semibold fos-num">{b.counts.possibleDuplicate}</p>
          </div>
          <div>
            <p className="text-sm text-ink-3">Errors</p>
            <p className="text-lg font-semibold fos-num">{b.counts.error}</p>
          </div>
        </div>
        {b.reconciliation && b.reconciliation.status === 'discrepancy' && (
          <Callout tone="warning">
            The statement's closing balance does not match the computed running balance ({b.reconciliation.detail}).
          </Callout>
        )}
      </Section>

      <QueryState query={preview} loadingLabel="Loading preview rows" isEmpty={(list) => list.length === 0} empty={<EmptyState title="No rows to preview" />}>
        {(items) => (
          <Table
            caption="Preview rows"
            hideCaption
            rows={items}
            getRowKey={(r) => String(r.rowNumber)}
            columns={[
              { key: 'date', header: 'Date', cell: (r) => r.bookedOn ?? '—' },
              { key: 'description', header: 'Description', primary: true, cell: (r) => r.description ?? '—' },
              { key: 'amount', header: 'Amount', numeric: true, cell: (r) => <Money value={r.amount} /> },
              { key: 'status', header: 'Status', cell: (r) => <Badge tone={ROW_STATUS_TONE[r.status] ?? 'neutral'}>{r.status.replace(/_/g, ' ')}</Badge> },
              {
                key: 'include',
                header: 'Include',
                cell: (r) =>
                  r.status === 'possible_duplicate' ? (
                    <Switch
                      label="Include"
                      checked={included.has(r.rowNumber)}
                      onCheckedChange={(v) =>
                        setIncluded((s) => {
                          const next = new Set(s);
                          if (v) next.add(r.rowNumber);
                          else next.delete(r.rowNumber);
                          return next;
                        })
                      }
                    />
                  ) : null,
              },
            ]}
          />
        )}
      </QueryState>

      {commit.isError && <Callout tone="critical">{userMessage(commit.error)}</Callout>}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={b.counts.new === 0 && included.size === 0}
          loading={commit.isPending}
          onClick={() =>
            commit.mutate(
              { id: batchId, includePossibleDuplicates: [...included] },
              { onSuccess: () => { toast({ title: 'Import committed', tone: 'success' }); onCommitted(); } },
            )
          }
        >
          Commit {b.counts.new + included.size} row{b.counts.new + included.size === 1 ? '' : 's'}
        </Button>
        <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(batchId)}>
          Cancel import
        </Button>
      </div>
      {possibleDuplicates.length === 0 && b.counts.new === 0 && <Callout tone="info">Every row in this statement already exists. There is nothing new to commit.</Callout>}
    </div>
  );
}

export function Component() {
  const navigate = useNavigate();
  const [batchId, setBatchId] = useState<string | null>(null);
  const batch = useImportBatch(batchId, { poll: true });
  const stepIndex = useMemo(() => {
    if (!batch.data) return 0;
    if (batch.data.status === 'committed') return 3;
    if (batch.data.status === 'previewed' || batch.data.status === 'failed') return 2;
    return 1;
  }, [batch.data]);

  return (
    <>
      <PageHeader title="Import a statement" description="Upload a bank or broker statement, confirm the mapping, review what will change, then commit." />
      <Stepper steps={STEPS} current={stepIndex} />
      <div className="mt-6">
        {!batchId && <UploadStep onUploaded={setBatchId} />}
        {batchId && batch.data?.status === 'uploaded' && <ConfigureStep batchId={batchId} onConfigured={() => undefined} />}
        {batchId && batch.data && !['uploaded'].includes(batch.data.status) && batch.data.status !== 'committed' && (
          <PreviewStep batchId={batchId} onCommitted={() => undefined} />
        )}
        {batchId && batch.data?.status === 'committed' && (
          <Card className="flex flex-col gap-4 p-6">
            <Callout tone="success">Import committed. Transactions were posted to suspense pending classification.</Callout>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => navigate(withContext('/money/transactions', new URLSearchParams()))}>
                Go to transactions
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setBatchId(null);
                }}
              >
                Import another statement
              </Button>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
