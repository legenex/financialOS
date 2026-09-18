import { useNavigate, useParams, useSearchParams } from 'react-router';
import { PageHeader, TabPanel, Tabs } from '@financialos/ui';
import { withContext } from '../../lib/context';
import { AchievementsTab } from './AchievementsTab';
import { ChatTab } from './ChatTab';
import { ReviewsTab } from './ReviewsTab';

export const COACH_TABS = [
  { value: 'ask', label: 'Ask' },
  { value: 'reviews', label: 'Reviews' },
  { value: 'achievements', label: 'Achievements' },
] as const;

type CoachTab = (typeof COACH_TABS)[number]['value'];

export function Component() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const current: CoachTab = COACH_TABS.some((t) => t.value === tab) ? (tab as CoachTab) : 'ask';
  return (
    <>
      <PageHeader title="Coach" description="Deterministic answers computed from your own records — never a guess, and never presented as something it isn't." />
      <Tabs
        label="Coach sections"
        value={current}
        onValueChange={(v) => navigate(withContext(`/coach/${v}`, params), { replace: true })}
        items={COACH_TABS.map((t) => ({ value: t.value, label: t.label }))}
      >
        <TabPanel value="ask">{current === 'ask' && <ChatTab />}</TabPanel>
        <TabPanel value="reviews">{current === 'reviews' && <ReviewsTab />}</TabPanel>
        <TabPanel value="achievements">{current === 'achievements' && <AchievementsTab />}</TabPanel>
      </Tabs>
    </>
  );
}
