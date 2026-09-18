import { Award, BadgeCheck, CheckCircle2, Flame, PiggyBank, ShieldCheck } from 'lucide-react';
import type { Achievement } from '@financialos/contracts';
import { Card, EmptyState, Link } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { useAchievements } from '../../lib/endpoints';
import { sourceLinkHref } from '../../lib/sourceLinks';

const ICON: Record<Achievement['kind'], React.ReactNode> = {
  review_completed: <CheckCircle2 size={20} />,
  reconciled_account: <ShieldCheck size={20} />,
  goal_contribution_verified: <PiggyBank size={20} />,
  verified_saving: <BadgeCheck size={20} />,
  exceptions_cleared: <Award size={20} />,
  streak: <Flame size={20} />,
};

const TITLE_FALLBACK: Record<Achievement['kind'], string> = {
  review_completed: 'Review completed',
  reconciled_account: 'Account reconciled',
  goal_contribution_verified: 'Goal contribution verified',
  verified_saving: 'Verified saving',
  exceptions_cleared: 'Exceptions cleared',
  streak: 'Streak',
};

export function AchievementsTab() {
  const achievements = useAchievements();
  return (
    <QueryState
      query={achievements}
      loadingLabel="Loading achievements"
      isEmpty={(list) => list.length === 0}
      empty={<EmptyState title="No achievements yet" description="Achievements are earned for verified progress: completed reviews, reconciled accounts, and confirmed savings — never estimates." />}
    >
      {(list) => (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((a) => (
            <Card key={a.id} className="flex flex-col gap-3 p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-ink">{ICON[a.kind]}</span>
                <div>
                  <p className="font-medium">{a.title || TITLE_FALLBACK[a.kind]}</p>
                  <p className="text-sm text-ink-3">{new Date(a.earnedAt).toLocaleDateString()}</p>
                </div>
              </div>
              {a.evidence.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {a.evidence.map((link, i) => {
                    const href = sourceLinkHref(link);
                    return href ? (
                      <Link key={`${link.id}-${i}`} href={href}>
                        {link.label}
                      </Link>
                    ) : (
                      <span key={`${link.id}-${i}`} className="text-sm text-ink-3">
                        {link.label}
                      </span>
                    );
                  })}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </QueryState>
  );
}
