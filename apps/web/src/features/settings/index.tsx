import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { PageHeader, TabPanel, Tabs } from '@financialos/ui';
import { withContext } from '../../lib/context';
import { AiProvidersTab } from './AiProvidersTab';
import { BackupsTab } from './BackupsTab';
import { GeneralTab } from './GeneralTab';
import { SecurityTab } from './SecurityTab';

export const SETTINGS_TABS = [
  { value: 'general', label: 'General' },
  { value: 'security', label: 'Security' },
  { value: 'ai', label: 'AI & agents' },
  { value: 'backups', label: 'Backups & automations' },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]['value'];

export function Component() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const segment = location.pathname.split('/')[2] ?? '';
  const current: SettingsTab = SETTINGS_TABS.some((t) => t.value === segment) ? (segment as SettingsTab) : 'general';

  return (
    <>
      <PageHeader title="Settings" description="Preferences, security and sessions, AI providers, backups and automations." />
      <Tabs
        label="Settings sections"
        value={current}
        onValueChange={(v) => navigate(withContext(`/settings/${v}`, params), { replace: true })}
        items={SETTINGS_TABS.map((t) => ({ value: t.value, label: t.label }))}
      >
        <TabPanel value="general">{current === 'general' && <GeneralTab />}</TabPanel>
        <TabPanel value="security">{current === 'security' && <SecurityTab />}</TabPanel>
        <TabPanel value="ai">{current === 'ai' && <AiProvidersTab />}</TabPanel>
        <TabPanel value="backups">{current === 'backups' && <BackupsTab />}</TabPanel>
      </Tabs>
    </>
  );
}
