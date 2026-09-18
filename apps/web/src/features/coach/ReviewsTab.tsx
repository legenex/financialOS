import { useState } from 'react';
import type { Review } from '@financialos/contracts';
import { Button, Callout, Card, Checkbox, EmptyState, Link, Section, StatusBadge, TextArea, useToast } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useReviews, useStartReview, useUpdateReview } from '../../lib/endpoints';

function ReviewCard({ review }: { review: Review }) {
  const update = useUpdateReview();
  const { toast } = useToast();
  const [notes, setNotes] = useState(review.notes ?? '');

  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold capitalize">{review.kind} review</h3>
          <p className="text-sm text-ink-3">
            {review.periodStart} – {review.periodEnd}
          </p>
        </div>
        <StatusBadge status={review.status === 'completed' ? 'ok' : review.status === 'in_progress' ? 'running' : 'queued'} label={review.status.replace('_', ' ')} />
      </div>

      {review.whatChanged.length > 0 && (
        <Section title="What changed">
          <div className="flex flex-col gap-3">
            {review.whatChanged.map((s) => (
              <div key={s.id}>
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-sm text-ink-3">{s.body}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {review.whyItMatters.length > 0 && (
        <Section title="Why it matters">
          <div className="flex flex-col gap-3">
            {review.whyItMatters.map((s) => (
              <div key={s.id}>
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-sm text-ink-3">{s.body}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {review.nextAction && (
        <Callout tone="info" title={review.nextAction.title}>
          {review.nextAction.body}
        </Callout>
      )}

      {review.checklist.length > 0 && (
        <Section title="Checklist">
          <div className="flex flex-col gap-2">
            {review.checklist.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3">
                <Checkbox
                  label={item.label}
                  checked={item.done}
                  onCheckedChange={(done) =>
                    update.mutate({ id: review.id, patch: { checklist: [{ id: item.id, done }] } })
                  }
                />
                {item.href && <Link href={item.href}>Open</Link>}
              </div>
            ))}
          </div>
        </Section>
      )}

      <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} />
      {update.isError && <Callout tone="critical">{userMessage(update.error)}</Callout>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => update.mutate({ id: review.id, patch: { notes } }, { onSuccess: () => toast({ title: 'Notes saved', tone: 'success' }) })}
          loading={update.isPending}
        >
          Save notes
        </Button>
        {review.status !== 'completed' && (
          <Button
            variant="primary"
            onClick={() =>
              update.mutate({ id: review.id, patch: { notes, complete: true } }, { onSuccess: () => toast({ title: 'Review completed', tone: 'success' }) })
            }
            loading={update.isPending}
          >
            Mark complete
          </Button>
        )}
      </div>
    </Card>
  );
}

export function ReviewsTab() {
  const reviews = useReviews();
  const startWeekly = useStartReview();
  const startMonthly = useStartReview();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => startWeekly.mutate('weekly')} loading={startWeekly.isPending}>
          Start weekly review
        </Button>
        <Button variant="secondary" onClick={() => startMonthly.mutate('monthly')} loading={startMonthly.isPending}>
          Start monthly review
        </Button>
      </div>
      {(startWeekly.isError || startMonthly.isError) && (
        <Callout tone="critical">{userMessage(startWeekly.error ?? startMonthly.error)}</Callout>
      )}
      <QueryState
        query={reviews}
        loadingLabel="Loading reviews"
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No reviews yet" description="Start a weekly or monthly review to see what changed and what to do next." />}
      >
        {(list) => (
          <div className="flex flex-col gap-6">
            {list.map((r) => (
              <ReviewCard key={r.id} review={r} />
            ))}
          </div>
        )}
      </QueryState>
    </div>
  );
}
