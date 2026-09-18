import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { PageHeader, TabPanel, Tabs } from '@financialos/ui';
import { withContext } from '../../lib/context';
import { AccountsTab } from './AccountsTab';
import { DocumentsTab } from './DocumentsTab';
import { OverviewTab } from './OverviewTab';
import { PortfolioTab } from './PortfolioTab';
import { TransactionsTab } from './TransactionsTab';

export const MONEY_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'transactions', label: 'Transactions' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'documents', label: 'Documents' },
] as const;

type MoneyTab = (typeof MONEY_TABS)[number]['value'];

export function Component() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const segment = location.pathname.split('/')[2] ?? '';
  const current: MoneyTab = MONEY_TABS.some((t) => t.value === segment) ? (segment as MoneyTab) : 'overview';

  return (
    <>
      <PageHeader title="Money" description="Accounts, transactions, investments, restricted holdings and the documents behind them." />
      <Tabs
        label="Money sections"
        value={current}
        onValueChange={(v) => navigate(withContext(`/money/${v}`, params), { replace: true })}
        items={MONEY_TABS.map((t) => ({ value: t.value, label: t.label }))}
      >
        <TabPanel value="overview">{current === 'overview' && <OverviewTab />}</TabPanel>
        <TabPanel value="accounts">{current === 'accounts' && <AccountsTab />}</TabPanel>
        <TabPanel value="transactions">{current === 'transactions' && <TransactionsTab />}</TabPanel>
        <TabPanel value="portfolio">{current === 'portfolio' && <PortfolioTab />}</TabPanel>
        <TabPanel value="documents">{current === 'documents' && <DocumentsTab />}</TabPanel>
      </Tabs>
    </>
  );
}
