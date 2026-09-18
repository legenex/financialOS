import { useEffect, useRef, useState } from 'react';
import { MessageCirclePlus, Send } from 'lucide-react';
import type { CoachMessage } from '@financialos/contracts';
import { Badge, Button, Callout, Card, EmptyState, Spinner, TextArea } from '@financialos/ui';
import { ApiErrorState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useAiProviders, useAskCoach, useCoachThread, useCoachThreads } from '../../lib/endpoints';

const QUICK_PROMPTS = [
  'What can I safely spend?',
  'Where did my money go?',
  'What changed this month?',
  'What are my biggest spending categories?',
  'What subscriptions changed?',
  'How long is my personal runway?',
  'How long is each business runway?',
  'What needs my attention?',
  'What should I do financially this week?',
  'Can I afford this purchase?',
  'What happens if my income drops?',
];

function ProviderNotice() {
  const providers = useAiProviders();
  const aiAvailable = (providers.data ?? []).some((p) => p.enabled && p.hasCredential && p.taskRouting.includes('coach_chat'));
  if (aiAvailable) return null;
  return (
    <Callout tone="neutral">
      No AI provider is connected for coaching, so every answer here is deterministic FinancialOS analysis — computed directly from your records, never a model's guess. Connect one in
      Settings → AI providers if you want narrative summaries in addition to this.
    </Callout>
  );
}

function MessageBubble({ message }: { message: CoachMessage }) {
  const isOwner = message.role === 'owner';
  return (
    <div className={`flex flex-col gap-1.5 max-w-[42rem] ${isOwner ? 'self-end items-end' : 'self-start items-start'}`}>
      <div className={`rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${isOwner ? 'bg-accent text-on-accent' : 'bg-surface-sunken text-ink'}`}>
        {message.content || (message.status === 'streaming' ? <Spinner size={16} label="Answering" /> : '')}
      </div>
      {!isOwner && (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <Badge tone={message.generatedBy === 'deterministic' ? 'neutral' : 'info'}>
            {message.generatedBy === 'deterministic' ? 'Deterministic FinancialOS analysis' : message.generatedBy}
          </Badge>
          {message.status === 'failed' && <Badge tone="negative">Failed</Badge>}
          {message.status === 'cancelled' && <Badge tone="neutral">Cancelled</Badge>}
          {message.links.length > 0 && (
            <span className="text-xs text-ink-3">
              Sources: {message.links.map((l) => l.label).join(', ')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatTab() {
  const threads = useCoachThreads();
  const [selected, setSelected] = useState<string | null>(null);
  const thread = useCoachThread(selected);
  const ask = useAskCoach();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [thread.data]);

  const send = (text: string) => {
    const message = text.trim();
    if (!message || ask.isPending) return;
    setDraft('');
    ask.mutate(
      { threadId: selected, message, mode: 'auto' },
      { onSuccess: (result) => setSelected(result.threadId) },
    );
  };

  const messages = thread.data ?? [];

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <Card className="w-full lg:w-64 shrink-0 flex flex-col gap-2 p-3">
        <Button variant="secondary" size="sm" leadingIcon={<MessageCirclePlus size={16} />} onClick={() => setSelected(null)}>
          New question
        </Button>
        {threads.isError && <Callout tone="warning">Threads could not be loaded.</Callout>}
        <div className="flex flex-col gap-1">
          {(threads.data ?? []).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelected(t.id)}
              className={`text-left rounded-lg px-3 py-2 text-sm truncate ${selected === t.id ? 'bg-surface-active font-medium' : 'hover:bg-surface-hover'}`}
            >
              {t.title || 'Untitled question'}
            </button>
          ))}
          {threads.isSuccess && threads.data.length === 0 && <p className="px-3 py-2 text-sm text-ink-3">No questions yet.</p>}
        </div>
      </Card>

      <div className="flex flex-1 flex-col gap-4 min-w-0">
        <ProviderNotice />
        <Card className="flex flex-col gap-4 p-4 min-h-[24rem]">
          <div ref={scrollRef} className="flex flex-col gap-4 max-h-[32rem] overflow-y-auto pr-1">
            {selected === null && messages.length === 0 ? (
              <EmptyState
                size="sm"
                title="Ask FinancialOS anything"
                description="Pick a question below, or type your own. Answers are computed from your accounts, transactions and plan — nothing is fabricated."
              />
            ) : thread.isError ? (
              <ApiErrorState error={thread.error} onRetry={() => void thread.refetch()} size="sm" />
            ) : (
              messages.map((m) => <MessageBubble key={m.id} message={m} />)
            )}
          </div>
          {(selected === null || messages.length === 0) && (
            <div className="flex flex-wrap gap-2">
              {QUICK_PROMPTS.map((p) => (
                <Button key={p} type="button" variant="secondary" size="sm" onClick={() => send(p)}>
                  {p}
                </Button>
              ))}
            </div>
          )}
          {ask.isError && <Callout tone="critical">{userMessage(ask.error)}</Callout>}
          <div className="flex items-end gap-2">
            <TextArea
              label="Ask a question"
              hideLabel
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask about spending, runway, budgets, a purchase…"
              rows={2}
              maxLength={4000}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
            />
            <Button variant="primary" leadingIcon={<Send size={16} />} onClick={() => send(draft)} loading={ask.isPending} disabled={!draft.trim()}>
              Ask
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
