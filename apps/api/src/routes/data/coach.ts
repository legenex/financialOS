/**
 * Coach: threads, messages, ask, the server-sent event stream, cancellation, structured reviews
 * and achievements.
 *
 * When no AI provider is configured for coach chat the answer comes from the deterministic coach in
 * @financialos/domain and is labelled `deterministic`; canned text is never presented as model
 * output. When a provider is configured the work is enqueued as an `ai.task` job and the reply is
 * streamed as the worker fills it in.
 */
import type { FastifyInstance } from 'fastify';
import { and, arrayOverlaps, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  CoachAskInput,
  type Achievement,
  type CoachMessage,
  type Review,
  type SourceLink,
} from '@financialos/contracts';
import { achievements as achievementsTable, aiProviders, coachMessages, coachThreads, reviews as reviewsTable } from '@financialos/db';
import { errors } from '../../errors';
import { parseBody, parseQuery } from '../../validation';
import { openSessionBoundStream } from '../../auth/streams';
import { iso } from '../../data/common';
import { answerDeterministic, buildReview, loadCoachFacts } from '../../data/coach';
import { audit, enqueueJob, financeBase, loadOne, ownerRoutes, requireUuid } from './_shared';

const STREAM_POLL_MS = 400;
const STREAM_MAX_POLLS = 600;

const ReviewCreateInput = z.object({ kind: z.enum(['weekly', 'monthly']) });
const ReviewPatchInput = z.object({
  checklist: z.array(z.object({ id: z.string().max(60), label: z.string().max(200), done: z.boolean(), href: z.string().max(200).nullable() })).max(50).optional(),
  notes: z.string().max(4000).nullable().optional(),
  complete: z.boolean().optional(),
});

type CoachMessageRow = typeof coachMessages.$inferSelect;
type ReviewRow = typeof reviewsTable.$inferSelect;

function messageView(row: CoachMessageRow): CoachMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    generatedBy: row.generatedBy,
    links: row.links as SourceLink[],
    createdAt: iso(row.createdAt),
    status: row.status,
  };
}

function reviewView(row: ReviewRow): Review {
  return {
    id: row.id,
    kind: row.kind,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    generatedBy: row.generatedBy,
    whatChanged: row.whatChanged as Review['whatChanged'],
    whyItMatters: row.whyItMatters as Review['whyItMatters'],
    nextAction: (row.nextAction as Review['nextAction']) ?? null,
    checklist: row.checklist as Review['checklist'],
    notes: row.notes,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
  };
}

export function registerCoachRoutes(app: FastifyInstance): void {
  ownerRoutes(app, (scope) => {
    scope.get('/api/coach/threads', async (req) => {
      const rows = await req.server.fos.db
        .select()
        .from(coachThreads)
        .where(isNull(coachThreads.archivedAt))
        .orderBy(desc(coachThreads.updatedAt))
        .limit(100);
      return { items: rows.map((row) => ({ id: row.id, title: row.title, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })) };
    });

    scope.get<{ Params: { id: string } }>('/api/coach/threads/:id', async (req): Promise<{ items: CoachMessage[] }> => {
      const id = requireUuid(req.params.id, 'thread_not_found');
      await loadOne(req.server.fos.db.select().from(coachThreads).where(eq(coachThreads.id, id)).limit(1), 'thread_not_found', 'Conversation not found.');
      const rows = await req.server.fos.db.select().from(coachMessages).where(eq(coachMessages.threadId, id)).orderBy(coachMessages.createdAt).limit(500);
      return { items: rows.map(messageView) };
    });

    scope.post('/api/coach/ask', async (req, reply): Promise<{ threadId: string; messageId: string; generatedBy: string; jobId: string | null }> => {
      const input = parseBody(CoachAskInput, req.body);
      const { db, clock } = req.server.fos;
      const now = clock.now();

      const threadId = await (async () => {
        if (input.threadId) {
          const thread = await loadOne(db.select().from(coachThreads).where(eq(coachThreads.id, input.threadId)).limit(1), 'thread_not_found', 'Conversation not found.');
          await db.update(coachThreads).set({ updatedAt: now }).where(eq(coachThreads.id, thread.id));
          return thread.id;
        }
        const [created] = await db
          .insert(coachThreads)
          .values({ title: input.message.slice(0, 80), createdAt: now, updatedAt: now })
          .returning();
        if (!created) throw new Error('coach thread insert returned no row');
        return created.id;
      })();

      await db.insert(coachMessages).values({
        threadId,
        role: 'owner',
        content: input.message,
        generatedBy: 'owner',
        links: [],
        status: 'complete',
        createdAt: now,
        completedAt: now,
      });

      const [provider] = await db
        .select()
        .from(aiProviders)
        .where(and(eq(aiProviders.enabled, true), arrayOverlaps(aiProviders.taskRouting, ['coach_chat'])))
        .limit(1);

      if (provider && input.mode !== 'deterministic_only') {
        const [placeholder] = await db
          .insert(coachMessages)
          .values({ threadId, role: 'coach', content: '', generatedBy: provider.model, providerId: provider.id, links: [], status: 'streaming', createdAt: now })
          .returning();
        if (!placeholder) throw new Error('coach message insert returned no row');
        const { jobId } = await enqueueJob(req, {
          queue: 'ai.task',
          label: 'Coach answer',
          data: { task: 'coach_chat', threadId, messageId: placeholder.id, providerId: provider.id },
          singletonKey: `ai.task:coach:${placeholder.id}`,
          idempotencyKey: `ai.task:coach:${placeholder.id}`,
          subjectType: 'coach_message',
          subjectId: placeholder.id,
        });
        await audit(req, 'coach.asked', { type: 'coach_thread', id: threadId }, 'Coach question sent to the configured provider', { providerId: provider.id, jobId });
        reply.code(202);
        return { threadId, messageId: placeholder.id, generatedBy: provider.model, jobId };
      }

      const base = await financeBase(req);
      const facts = await loadCoachFacts(req.server.fos, base);
      const answer = answerDeterministic(input.message, facts);
      const [message] = await db
        .insert(coachMessages)
        .values({
          threadId,
          role: 'coach',
          content: answer.content,
          generatedBy: answer.generatedBy,
          links: answer.links,
          status: 'complete',
          createdAt: now,
          completedAt: now,
        })
        .returning();
      if (!message) throw new Error('coach message insert returned no row');
      await audit(req, 'coach.asked', { type: 'coach_thread', id: threadId }, 'Coach answered from the records (deterministic)', { topic: answer.topic });
      reply.code(201);
      return { threadId, messageId: message.id, generatedBy: answer.generatedBy, jobId: null };
    });

    scope.get<{ Params: { messageId: string } }>('/api/coach/stream/:messageId', async (req, reply) => {
      const messageId = requireUuid(req.params.messageId, 'message_not_found');
      const { db, clock } = req.server.fos;
      await loadOne(db.select().from(coachMessages).where(eq(coachMessages.id, messageId)).limit(1), 'message_not_found', 'Message not found.');
      const stream = await openSessionBoundStream(req, reply);
      let sent = 0;
      for (let poll = 0; poll < STREAM_MAX_POLLS && !stream.closed; poll += 1) {
        const [row] = await db.select().from(coachMessages).where(eq(coachMessages.id, messageId)).limit(1);
        if (!row) break;
        if (row.content.length > sent) {
          // The session is re-checked inside send() before anything is written.
          const ok = await stream.send('delta', { text: row.content.slice(sent) });
          if (!ok) return reply;
          sent = row.content.length;
        }
        if (row.status !== 'streaming') {
          await stream.send('done', { status: row.status, message: messageView(row) });
          break;
        }
        await new Promise<void>((resolve) => {
          clock.setTimer(STREAM_POLL_MS, resolve);
        });
      }
      stream.close();
      return reply;
    });

    scope.post<{ Params: { id: string } }>('/api/coach/messages/:id/cancel', async (req): Promise<CoachMessage> => {
      const id = requireUuid(req.params.id, 'message_not_found');
      const { db, clock } = req.server.fos;
      const [row] = await db
        .update(coachMessages)
        .set({ cancelRequestedAt: clock.now(), status: 'cancelled', completedAt: clock.now() })
        .where(and(eq(coachMessages.id, id), eq(coachMessages.status, 'streaming')))
        .returning();
      if (!row) {
        const existing = await loadOne(db.select().from(coachMessages).where(eq(coachMessages.id, id)).limit(1), 'message_not_found', 'Message not found.');
        return messageView(existing);
      }
      await audit(req, 'coach.cancelled', { type: 'coach_message', id }, 'Coach answer cancelled');
      return messageView(row);
    });

    // --- Reviews -------------------------------------------------------------------------
    scope.get('/api/reviews', async (req): Promise<{ items: Review[] }> => {
      const query = parseQuery(z.object({ kind: z.enum(['weekly', 'monthly']).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
      const rows = await req.server.fos.db
        .select()
        .from(reviewsTable)
        .where(query.kind ? eq(reviewsTable.kind, query.kind) : undefined)
        .orderBy(desc(reviewsTable.periodEnd))
        .limit(query.limit);
      return { items: rows.map(reviewView) };
    });

    scope.post('/api/reviews', async (req, reply): Promise<Review> => {
      const input = parseBody(ReviewCreateInput, req.body);
      const { db, clock } = req.server.fos;
      const base = await financeBase(req);
      const facts = await loadCoachFacts(req.server.fos, base);
      const draft = buildReview(input.kind, facts);
      const values = {
        kind: draft.kind,
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
        status: 'draft' as const,
        generatedBy: draft.generatedBy,
        whatChanged: draft.whatChanged as unknown as Array<Record<string, unknown>>,
        whyItMatters: draft.whyItMatters as unknown as Array<Record<string, unknown>>,
        nextAction: (draft.nextAction as unknown as Record<string, unknown>) ?? null,
        checklist: draft.checklist as unknown as Array<Record<string, unknown>>,
        startedAt: clock.now(),
        updatedAt: clock.now(),
      };
      const [row] = await db
        .insert(reviewsTable)
        .values(values)
        .onConflictDoUpdate({ target: [reviewsTable.kind, reviewsTable.periodStart], set: values })
        .returning();
      if (!row) throw new Error('review upsert returned no row');
      await audit(req, 'review.created', { type: 'review', id: row.id }, `${input.kind} review prepared (deterministic)`);
      reply.code(201);
      return reviewView(row);
    });

    scope.patch<{ Params: { id: string } }>('/api/reviews/:id', async (req): Promise<Review> => {
      const id = requireUuid(req.params.id, 'review_not_found');
      const input = parseBody(ReviewPatchInput, req.body);
      const { db, clock } = req.server.fos;
      const now = clock.now();
      const [row] = await db
        .update(reviewsTable)
        .set({
          ...(input.checklist ? { checklist: input.checklist as unknown as Array<Record<string, unknown>> } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.complete ? { status: 'completed' as const, completedAt: now } : input.checklist || input.notes !== undefined ? { status: 'in_progress' as const } : {}),
          updatedAt: now,
        })
        .where(eq(reviewsTable.id, id))
        .returning();
      if (!row) throw errors.notFound('review_not_found', 'Review not found.');
      if (input.complete) await audit(req, 'review.completed', { type: 'review', id }, `${row.kind} review completed`);
      return reviewView(row);
    });

    scope.get('/api/achievements', async (req): Promise<{ items: Achievement[] }> => {
      const rows = await req.server.fos.db.select().from(achievementsTable).orderBy(desc(achievementsTable.earnedAt)).limit(200);
      return {
        items: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          earnedAt: iso(row.earnedAt),
          evidence: row.evidence as SourceLink[],
        })),
      };
    });
  });
}
