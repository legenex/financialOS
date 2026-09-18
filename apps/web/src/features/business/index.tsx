import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import type { EntityKind } from '@financialos/contracts';
import { Button, Callout, Dialog, PageHeader, Select, TabPanel, Tabs, TextField, useToast } from '@financialos/ui';
import { withContext } from '../../lib/context';
import { userMessage } from '../../lib/api';
import { useCreateEntity } from './api';
import { ClearingTab } from './ClearingTab';
import { ForecastTab } from './ForecastTab';
import { OverviewTab } from './OverviewTab';
import { ReceivablesTab } from './ReceivablesTab';
import { SupportTab } from './SupportTab';

export const BUSINESS_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'forecast', label: 'Forecast' },
  { value: 'receivables', label: 'Receivables & payables' },
  { value: 'clearing', label: 'Third-party clearing' },
  { value: 'support', label: 'Owner support' },
] as const;

type BusinessTab = (typeof BUSINESS_TABS)[number]['value'];

const KIND_OPTIONS: Array<{ value: EntityKind; label: string }> = [
  { value: 'company', label: 'Company' },
  { value: 'trust', label: 'Trust' },
  { value: 'third_party', label: 'Third party' },
];

function AddEntity() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<EntityKind>('company');
  const create = useCreateEntity();
  const { toast } = useToast();

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Add a business entity"
      trigger={
        <Button variant="primary" leadingIcon={<Plus size={16} />}>
          Add entity
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                { name: name.trim(), kind, jurisdiction: null, baseCurrency: null, ownerControlled: true, legalStatusConfirmed: false, notes: null },
                {
                  onSuccess: () => {
                    toast({ title: 'Entity added', tone: 'success' });
                    setName('');
                    setOpen(false);
                  },
                },
              )
            }
          >
            Add
          </Button>
        </>
      }
    >
      {create.isError && <Callout tone="critical">{userMessage(create.error)}</Callout>}
      <div className="flex flex-col gap-4">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <Select label="Kind" value={kind} onValueChange={(v) => setKind((v as EntityKind) ?? kind)} options={KIND_OPTIONS} />
      </div>
    </Dialog>
  );
}

export function Component() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const segment = location.pathname.split('/')[2] ?? '';
  const current: BusinessTab = BUSINESS_TABS.some((t) => t.value === segment) ? (segment as BusinessTab) : 'overview';

  return (
    <>
      <PageHeader
        title="Business"
        description="Each entity on a cash basis, the consolidated view, the 13-week forecast and third-party clearing."
        actions={<AddEntity />}
      />
      <Tabs
        label="Business sections"
        value={current}
        onValueChange={(v) => navigate(withContext(`/business/${v}`, params), { replace: true })}
        items={BUSINESS_TABS.map((t) => ({ value: t.value, label: t.label }))}
      >
        <TabPanel value="overview">{current === 'overview' && <OverviewTab />}</TabPanel>
        <TabPanel value="forecast">{current === 'forecast' && <ForecastTab />}</TabPanel>
        <TabPanel value="receivables">{current === 'receivables' && <ReceivablesTab />}</TabPanel>
        <TabPanel value="clearing">{current === 'clearing' && <ClearingTab />}</TabPanel>
        <TabPanel value="support">{current === 'support' && <SupportTab />}</TabPanel>
      </Tabs>
    </>
  );
}
