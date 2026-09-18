import { useNavigate, useParams, useSearchParams } from 'react-router';
import { PageHeader, TabPanel, Tabs } from '@financialos/ui';
import { withContext } from '../../lib/context';
import { BudgetTab } from './BudgetTab';
import { CommitmentsTab } from './CommitmentsTab';
import { GoalsTab } from './GoalsTab';
import { SimulatorTab } from './SimulatorTab';
import { SubscriptionsTab } from './SubscriptionsTab';

export const PLAN_TABS = [
  { value: 'budget', label: 'Budget' },
  { value: 'goals', label: 'Goals' },
  { value: 'commitments', label: 'Commitments' },
  { value: 'subscriptions', label: 'Subscriptions' },
  { value: 'simulator', label: 'Simulator' },
] as const;

type PlanTab = (typeof PLAN_TABS)[number]['value'];

export function Component() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const current: PlanTab = PLAN_TABS.some((t) => t.value === tab) ? (tab as PlanTab) : 'budget';
  return (
    <>
      <PageHeader title="Plan" description="Decide where money goes before it goes: budgets, reserves, commitments and what a purchase would change." />
      <Tabs
        label="Plan sections"
        value={current}
        onValueChange={(v) => navigate(withContext(`/plan/${v}`, params), { replace: true })}
        items={PLAN_TABS.map((t) => ({ value: t.value, label: t.label }))}
      >
        <TabPanel value="budget">{current === 'budget' && <BudgetTab />}</TabPanel>
        <TabPanel value="goals">{current === 'goals' && <GoalsTab />}</TabPanel>
        <TabPanel value="commitments">{current === 'commitments' && <CommitmentsTab />}</TabPanel>
        <TabPanel value="subscriptions">{current === 'subscriptions' && <SubscriptionsTab />}</TabPanel>
        <TabPanel value="simulator">{current === 'simulator' && <SimulatorTab />}</TabPanel>
      </Tabs>
    </>
  );
}
