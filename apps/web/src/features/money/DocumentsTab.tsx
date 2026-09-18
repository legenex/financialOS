import { useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { Download, Upload } from 'lucide-react';
import type { DocumentRecord } from '@financialos/contracts';
import { Button, Callout, Card, EmptyState, Section, Select, Table, TextField, useToast, formatDateTime } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useAccounts, useEntities } from '../../lib/endpoints';
import { documentDownloadUrl, useDocuments, useUploadDocument } from './api';

const KIND_OPTIONS: Array<{ value: DocumentRecord['kind']; label: string }> = [
  { value: 'statement', label: 'Statement' },
  { value: 'agreement', label: 'Agreement' },
  { value: 'valuation', label: 'Valuation' },
  { value: 'tax', label: 'Tax' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'other', label: 'Other' },
];

function UploadForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const accounts = useAccounts();
  const entities = useEntities();
  const upload = useUploadDocument();
  const { toast } = useToast();
  const [kind, setKind] = useState<DocumentRecord['kind']>('statement');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const submit = () => {
    if (!file) return;
    upload.mutate(
      { file, kind, accountId, entityId, note: note.trim() || null },
      {
        onSuccess: () => {
          toast({ title: 'Document uploaded', tone: 'success' });
          setFile(null);
          setNote('');
          if (inputRef.current) inputRef.current.value = '';
        },
      },
    );
  };

  return (
    <Card className="flex flex-col gap-4 p-5">
      {upload.isError && <Callout tone="critical">{userMessage(upload.error)}</Callout>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="doc-file" className="text-sm font-medium">
            File
          </label>
          <input
            id="doc-file"
            ref={inputRef}
            type="file"
            accept=".pdf,.csv,.xlsx,.ofx,.qfx,.xml,.png,.jpg,.jpeg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="fos-field__input"
          />
        </div>
        <Select label="Kind" value={kind} onValueChange={(v) => setKind((v as DocumentRecord['kind']) ?? kind)} options={KIND_OPTIONS} />
        <Select label="Account (optional)" value={accountId} onValueChange={setAccountId} options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }))} placeholder="No account" />
        <Select label="Entity (optional)" value={entityId} onValueChange={setEntityId} options={(entities.data ?? []).map((e) => ({ value: e.id, label: e.name }))} placeholder="No entity" />
        <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </div>
      <div className="flex justify-end">
        <Button variant="primary" leadingIcon={<Upload size={16} />} onClick={submit} disabled={!file} loading={upload.isPending}>
          Upload
        </Button>
      </div>
    </Card>
  );
}

export function DocumentsTab() {
  const documents = useDocuments();
  return (
    <div className="flex flex-col gap-6">
      <Callout tone="neutral">
        Documents are encrypted at rest. To import transactions from a statement rather than just store it, use{' '}
        <RouterLink to="/imports">Imports</RouterLink>.
      </Callout>
      <UploadForm />
      <QueryState
        query={documents}
        loadingLabel="Loading documents"
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No documents yet" description="Upload a statement, agreement or valuation to keep it alongside your accounts." />}
      >
        {(list) => (
          <Section title="Documents">
            <Table
              caption="Documents"
              hideCaption
              rows={list}
              getRowKey={(d) => d.id}
              columns={[
                { key: 'name', header: 'File', primary: true, cell: (d) => d.fileName },
                { key: 'kind', header: 'Kind', cell: (d) => KIND_OPTIONS.find((k) => k.value === d.kind)?.label ?? d.kind },
                { key: 'uploaded', header: 'Uploaded', hideOnMobile: true, cell: (d) => formatDateTime(d.uploadedAt) },
                {
                  key: 'download',
                  header: <span className="fos-sr-only">Download</span>,
                  align: 'end',
                  cell: (d) => (
                    <a href={documentDownloadUrl(d.id)} className="fos-table__action" aria-label={`Download ${d.fileName}`}>
                      <Download size={15} aria-hidden="true" />
                    </a>
                  ),
                },
              ]}
            />
          </Section>
        )}
      </QueryState>
    </div>
  );
}
