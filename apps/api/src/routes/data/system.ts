/**
 * System: jobs (list, detail, cancel, progress stream), settings, schedules, system status,
 * domain-migration planning, backups, the audit log, notifications, search and the exception inbox.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AppSettings,
  DomainMigrationInput,
  ExceptionResolveInput,
  ScheduleUpdateInput,
  type AuditEvent,
  type BackupRecord,
  type DomainMigrationPlan,
  type ExceptionItem,
  type JobRecord,
  type Notification,
  type Schedule,
  type SearchResult,
  type SystemStatus,
} from '@financialos/contracts';
import {
  accounts as accountsTable,
  auditEvents,
  backups,
  connections as connectionsTable,
  documents as documentsTable,
  entities as entitiesTable,
  exceptions as exceptionsTable,
  goals as goalsTable,
  jobRecords,
  notifications as notificationsTable,
  schedules as schedulesTable,
  sourceRecords,
} from '@financialos/db';
import { errors } from '../../errors';
import { parseBody, parseQuery } from '../../validation';
import { openSessionBoundStream } from '../../auth/streams';
import { APP_VERSION } from '../../version';
import { iso, loadSettings, writeSetting } from '../../data/common';
import { backupView, buildSystemStatus } from '../../data/system';
import { audit, enqueueJob, jobRecordView, loadOne, ownerRoutes, requireUuid } from './_shared';

const JOB_POLL_MS = 500;
const JOB_MAX_POLLS = 600;
const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'cancelling', 'dead_letter', 'retrying'] as const;

const JobQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  queue: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const AuditQuery = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const SearchQuery = z.object({ q: z.string().min(1).max(120), limit: z.coerce.number().int().min(1).max(50).default(20) });
const ExceptionQuery = z.object({ status: z.enum(['open', 'resolved', 'dismissed', 'snoozed']).optional(), kind: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

function exceptionView(row: typeof exceptionsTable.$inferSelect): ExceptionItem {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    title: row.title,
    detail: row.body,
    subject: { type: row.subjectType, id: row.subjectId, label: row.subjectLabel },
    entityId: row.entityId,
    suggestedActions: row.suggestedActions,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    snoozedUntil: iso(row.snoozedUntil),
    resolution: row.resolution,
  };
}

function notificationView(row: typeof notificationsTable.$inferSelect): Notification {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    why: row.why,
    href: row.href,
    createdAt: iso(row.createdAt),
    readAt: iso(row.readAt),
  };
}

function scheduleView(row: typeof schedulesTable.$inferSelect): Schedule {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    description: row.description,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled,
    lastRunAt: iso(row.lastRunAt),
    lastStatus: row.lastStatus,
    nextRunAt: iso(row.nextRunAt),
  };
}

function like(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function registerSystemRoutes(app: FastifyInstance): void {
  ownerRoutes(app, (scope) => {
    // --- Jobs -----------------------------------------------------------------------------
    scope.get('/api/jobs', async (req): Promise<{ items: JobRecord[] }> => {
      const query = parseQuery(JobQuery, req.query);
      const conditions = [];
      if (query.status) conditions.push(eq(jobRecords.status, query.status));
      if (query.queue) conditions.push(eq(jobRecords.queue, query.queue));
      const rows = await req.server.fos.db
        .select()
        .from(jobRecords)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(jobRecords.createdAt))
        .limit(query.limit);
      return { items: rows.map(jobRecordView) };
    });

    scope.get<{ Params: { id: string } }>('/api/jobs/:id', async (req): Promise<JobRecord> => {
      const id = requireUuid(req.params.id, 'job_not_found');
      const row = await loadOne(req.server.fos.db.select().from(jobRecords).where(eq(jobRecords.id, id)).limit(1), 'job_not_found', 'Job not found.');
      return jobRecordView(row);
    });

    scope.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req): Promise<JobRecord> => {
      const id = requireUuid(req.params.id, 'job_not_found');
      const { db, clock } = req.server.fos;
      const now = clock.now();
      const [row] = await db
        .update(jobRecords)
        .set({
          cancelRequestedAt: now,
          // A job that has not started yet is cancelled outright; a running one is asked to stop.
          status: sql`CASE WHEN ${jobRecords.status} IN ('queued', 'retrying') THEN 'cancelling' ELSE 'cancelling' END`,
          updatedAt: now,
        })
        .where(and(eq(jobRecords.id, id), eq(jobRecords.cancellable, true), inArray(jobRecords.status, ['queued', 'retrying', 'running'])))
        .returning();
      if (!row) {
        const existing = await loadOne(db.select().from(jobRecords).where(eq(jobRecords.id, id)).limit(1), 'job_not_found', 'Job not found.');
        if (!existing.cancellable) throw errors.conflict('job_not_cancellable', 'This job cannot be cancelled.');
        return jobRecordView(existing);
      }
      await audit(req, 'job.cancel_requested', { type: 'job', id }, `Cancellation requested for ${row.queue}`);
      return jobRecordView(row);
    });

    scope.get<{ Params: { id: string } }>('/api/jobs/:id/events', async (req, reply) => {
      const id = requireUuid(req.params.id, 'job_not_found');
      const { db, clock } = req.server.fos;
      await loadOne(db.select().from(jobRecords).where(eq(jobRecords.id, id)).limit(1), 'job_not_found', 'Job not found.');
      const stream = await openSessionBoundStream(req, reply);
      let last = '';
      for (let poll = 0; poll < JOB_MAX_POLLS && !stream.closed; poll += 1) {
        const [row] = await db.select().from(jobRecords).where(eq(jobRecords.id, id)).limit(1);
        if (!row) break;
        const view = jobRecordView(row);
        const signature = `${view.status}:${view.progress ?? ''}:${view.progressLabel ?? ''}`;
        if (signature !== last) {
          const ok = await stream.send('progress', view);
          if (!ok) return reply;
          last = signature;
        }
        if (['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(view.status)) {
          await stream.send('done', view);
          break;
        }
        await new Promise<void>((resolve) => {
          clock.setTimer(JOB_POLL_MS, resolve);
        });
      }
      stream.close();
      return reply;
    });

    // --- Settings and schedules --------------------------------------------------------------
    scope.get('/api/settings', async (req): Promise<AppSettings> => loadSettings(req.server.fos.db));

    scope.put('/api/settings', async (req): Promise<AppSettings> => {
      const input = parseBody(AppSettings.partial(), req.body);
      const { db } = req.server.fos;
      const keys = Object.keys(input);
      if (keys.length === 0) throw errors.badRequest('No settings were sent.');
      await db.transaction(async (tx) => {
        for (const [key, value] of Object.entries(input)) {
          if (value !== undefined) await writeSetting(tx, key, value);
        }
      });
      await audit(req, 'settings.updated', { type: 'settings' }, 'Application settings updated', { keys });
      return loadSettings(db);
    });

    scope.get('/api/schedules', async (req): Promise<{ items: Schedule[] }> => {
      const rows = await req.server.fos.db.select().from(schedulesTable).orderBy(asc(schedulesTable.key)).limit(100);
      return { items: rows.map(scheduleView) };
    });

    scope.put<{ Params: { id: string } }>('/api/schedules/:id', async (req): Promise<Schedule> => {
      const id = requireUuid(req.params.id, 'schedule_not_found');
      const input = parseBody(ScheduleUpdateInput, req.body);
      const { db, clock } = req.server.fos;
      const [row] = await db
        .update(schedulesTable)
        .set({ cron: input.cron, timezone: input.timezone, enabled: input.enabled, updatedAt: clock.now() })
        .where(eq(schedulesTable.id, id))
        .returning();
      if (!row) throw errors.notFound('schedule_not_found', 'Schedule not found.');
      await audit(req, 'schedule.updated', { type: 'schedule', id }, `Schedule ${row.key} updated`, { enabled: row.enabled });
      return scheduleView(row);
    });

    // --- System status ------------------------------------------------------------------------
    scope.get('/api/system', async (req): Promise<SystemStatus> => {
      const { db, config, clock, extensionOrigins } = req.server.fos;
      return buildSystemStatus(db, config, { version: APP_VERSION, now: clock.now(), extensionOrigins });
    });

    scope.post('/api/system/domain-migration/plan', async (req): Promise<DomainMigrationPlan> => {
      const input = parseBody(DomainMigrationInput, req.body);
      const { config, db } = req.server.fos;
      let proposed: URL;
      try {
        proposed = new URL(input.proposedOrigin);
      } catch {
        throw errors.badRequest('The proposed origin is not a URL.');
      }
      const current = new URL(config.canonicalOrigin);
      const checks: DomainMigrationPlan['checks'] = [];
      const push = (id: string, label: string, status: DomainMigrationPlan['checks'][number]['status'], detail: string) => checks.push({ id, label, status, detail });

      push('format', 'Proposed origin is an exact origin', proposed.origin === input.proposedOrigin.replace(/\/$/, '') ? 'pass' : 'fail', `Parsed as ${proposed.origin}`);
      push('https', 'Proposed origin uses HTTPS', proposed.protocol === 'https:' ? 'pass' : 'fail', `Scheme ${proposed.protocol.replace(':', '')}`);
      push('different', 'Proposed origin differs from the current one', proposed.origin === current.origin ? 'fail' : 'pass', `Current ${current.origin}`);
      push(
        'allowed_origins',
        'Proposed origin is in allowedOrigins',
        config.allowedOrigins.includes(proposed.origin) ? 'pass' : 'todo',
        'Add it to the runtime configuration and restart before switching.',
      );
      push(
        'passkeys',
        'Passkeys stay usable',
        proposed.hostname === current.hostname ? 'pass' : 'warning',
        proposed.hostname === current.hostname
          ? 'The host name does not change, so registered passkeys keep working.'
          : 'Passkeys are bound to the current host name. They must be re-registered after the move, so keep the password and TOTP factor available.',
      );
      const connectionCount = (await db.select({ n: sql<number>`count(*)::int` }).from(connectionsTable))[0]?.n ?? 0;
      push(
        'oauth_redirects',
        'OAuth redirect URIs need re-registration',
        connectionCount > 0 ? 'todo' : 'pass',
        connectionCount > 0
          ? `${connectionCount} connection(s) exist. Every provider's redirect URI must be changed to ${proposed.origin}/api/oauth/callback.`
          : 'No connections exist yet, so nothing has to be re-registered.',
      );
      push('extension', 'Extension pairing survives', 'warning', 'Paired extensions store the server origin. Re-pair each device after the move.');

      await audit(req, 'system.domain_migration_planned', { type: 'system' }, 'Domain migration plan produced', { proposedHost: proposed.hostname });
      return {
        currentOrigin: current.origin,
        proposedOrigin: proposed.origin,
        checks,
        consequences: [
          'Sessions are host-only cookies: everyone is signed out at the switch.',
          'Passkeys registered against the old host name stop working unless the host name is unchanged.',
          'Every OAuth provider redirect URI has to be re-registered before connections can be re-authorised.',
          'Paired browser extensions must be paired again.',
          'The launch links stored in the extension point at the old origin until it is re-paired.',
        ],
      };
    });

    // --- Backups -------------------------------------------------------------------------------
    scope.get('/api/backups', async (req): Promise<{ items: BackupRecord[] }> => {
      const rows = await req.server.fos.db.select().from(backups).orderBy(desc(backups.startedAt)).limit(100);
      return { items: rows.map(backupView) };
    });

    scope.post('/api/backups', async (req): Promise<{ jobId: string }> => {
      const { clock } = req.server.fos;
      const result = await enqueueJob(req, {
        queue: 'backup.run',
        label: 'Backup',
        data: { requestedAt: clock.now().toISOString() },
        singletonKey: 'backup.run',
        cancellable: false,
        subjectType: 'backup',
      });
      await audit(req, 'backup.requested', { type: 'backup' }, 'Backup scheduled', { jobId: result.jobId });
      return result;
    });

    scope.post<{ Params: { id: string } }>('/api/backups/:id/verify', async (req): Promise<{ jobId: string }> => {
      const id = requireUuid(req.params.id, 'backup_not_found');
      const { db } = req.server.fos;
      const row = await loadOne(db.select().from(backups).where(eq(backups.id, id)).limit(1), 'backup_not_found', 'Backup not found.');
      if (row.status !== 'succeeded') throw errors.conflict('backup_not_verifiable', 'Only a completed backup can be verified.');
      const result = await enqueueJob(req, {
        queue: 'backup.verify',
        label: 'Restore verification',
        data: { backupId: id },
        singletonKey: `backup.verify:${id}`,
        cancellable: false,
        subjectType: 'backup',
        subjectId: id,
      });
      await audit(req, 'backup.verify_requested', { type: 'backup', id }, 'Restore verification scheduled', { jobId: result.jobId });
      return result;
    });

    // --- Audit log --------------------------------------------------------------------------------
    scope.get('/api/audit', async (req): Promise<{ items: AuditEvent[]; nextCursor: string | null }> => {
      const query = parseQuery(AuditQuery, req.query);
      const cursorId = query.cursor ? Number.parseInt(query.cursor, 10) : null;
      if (query.cursor && (cursorId === null || !Number.isSafeInteger(cursorId))) throw errors.badRequest('The paging cursor is not valid.');
      const rows = await req.server.fos.db
        .select()
        .from(auditEvents)
        .where(cursorId === null ? undefined : lt(auditEvents.id, cursorId))
        .orderBy(desc(auditEvents.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: String(row.id),
          occurredAt: iso(row.occurredAt),
          actorType: row.actorType,
          actorId: row.actorId,
          action: row.action,
          objectType: row.objectType,
          objectId: row.objectId,
          summary: row.summary,
        })),
        nextCursor: rows.length > query.limit && last ? String(last.id) : null,
      };
    });

    // --- Notifications -----------------------------------------------------------------------------
    scope.get('/api/notifications', async (req): Promise<{ items: Notification[]; unread: number }> => {
      const { db } = req.server.fos;
      const [rows, unread] = await Promise.all([
        db.select().from(notificationsTable).where(isNull(notificationsTable.dismissedAt)).orderBy(desc(notificationsTable.createdAt)).limit(100),
        db.select({ n: sql<number>`count(*)::int` }).from(notificationsTable).where(and(isNull(notificationsTable.readAt), isNull(notificationsTable.dismissedAt))),
      ]);
      return { items: rows.map(notificationView), unread: unread[0]?.n ?? 0 };
    });

    scope.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (req): Promise<Notification> => {
      const id = requireUuid(req.params.id, 'notification_not_found');
      const { db, clock } = req.server.fos;
      const [row] = await db
        .update(notificationsTable)
        .set({ readAt: sql`coalesce(${notificationsTable.readAt}, ${clock.now().toISOString()}::timestamptz)` })
        .where(eq(notificationsTable.id, id))
        .returning();
      if (!row) throw errors.notFound('notification_not_found', 'Notification not found.');
      return notificationView(row);
    });

    scope.post('/api/notifications/read-all', async (req) => {
      const { db, clock } = req.server.fos;
      const rows = await db
        .update(notificationsTable)
        .set({ readAt: clock.now() })
        .where(isNull(notificationsTable.readAt))
        .returning({ id: notificationsTable.id });
      return { read: rows.length };
    });

    // --- Search ---------------------------------------------------------------------------------------
    scope.get('/api/search', async (req): Promise<SearchResult> => {
      const query = parseQuery(SearchQuery, req.query);
      const { db } = req.server.fos;
      const term = like(query.q);
      const per = Math.max(3, Math.ceil(query.limit / 5));
      const [accountRows, transactionRows, entityRows, goalRows, connectionRows, exceptionRows, documentRows] = await Promise.all([
        db.select({ id: accountsTable.id, name: accountsTable.name, kind: accountsTable.kind }).from(accountsTable).where(ilike(accountsTable.name, term)).limit(per),
        db
          .select({ id: sourceRecords.id, description: sourceRecords.description, bookedOn: sourceRecords.bookedOn })
          .from(sourceRecords)
          .where(and(eq(sourceRecords.recordKind, 'transaction'), or(ilike(sourceRecords.description, term), ilike(sourceRecords.counterpartyName, term))))
          .orderBy(desc(sourceRecords.bookedOn))
          .limit(per),
        db.select({ id: entitiesTable.id, name: entitiesTable.name, kind: entitiesTable.kind }).from(entitiesTable).where(ilike(entitiesTable.name, term)).limit(per),
        db.select({ id: goalsTable.id, name: goalsTable.name, kind: goalsTable.kind }).from(goalsTable).where(ilike(goalsTable.name, term)).limit(per),
        db.select({ id: connectionsTable.id, name: connectionsTable.name, providerKey: connectionsTable.providerKey }).from(connectionsTable).where(ilike(connectionsTable.name, term)).limit(per),
        db.select({ id: exceptionsTable.id, title: exceptionsTable.title, kind: exceptionsTable.kind }).from(exceptionsTable).where(ilike(exceptionsTable.title, term)).limit(per),
        db.select({ id: documentsTable.id, fileName: documentsTable.fileName, kind: documentsTable.kind }).from(documentsTable).where(ilike(documentsTable.fileName, term)).limit(per),
      ]);
      const items: SearchResult['items'] = [
        ...accountRows.map((r) => ({ kind: 'account' as const, id: r.id, title: r.name, subtitle: r.kind, href: `/money/accounts/${r.id}` })),
        ...transactionRows.map((r) => ({ kind: 'transaction' as const, id: r.id, title: r.description ?? 'Transaction', subtitle: r.bookedOn, href: `/money/transactions/${r.id}` })),
        ...entityRows.map((r) => ({ kind: 'entity' as const, id: r.id, title: r.name, subtitle: r.kind, href: `/business?entityId=${r.id}` })),
        ...goalRows.map((r) => ({ kind: 'goal' as const, id: r.id, title: r.name, subtitle: r.kind, href: `/plan/goals/${r.id}` })),
        ...connectionRows.map((r) => ({ kind: 'connection' as const, id: r.id, title: r.name, subtitle: r.providerKey, href: `/connections/${r.id}` })),
        ...exceptionRows.map((r) => ({ kind: 'exception' as const, id: r.id, title: r.title, subtitle: r.kind, href: `/inbox?id=${r.id}` })),
        ...documentRows.map((r) => ({ kind: 'document' as const, id: r.id, title: r.fileName, subtitle: r.kind, href: `/money/documents/${r.id}` })),
      ];
      return { items: items.slice(0, query.limit) };
    });

    // --- Exception inbox ----------------------------------------------------------------------------------
    scope.get('/api/exceptions', async (req): Promise<{ items: ExceptionItem[] }> => {
      const query = parseQuery(ExceptionQuery, req.query);
      const conditions = [];
      if (query.status) conditions.push(eq(exceptionsTable.status, query.status));
      if (query.kind) conditions.push(eq(exceptionsTable.kind, query.kind as typeof exceptionsTable.$inferSelect.kind));
      const rows = await req.server.fos.db
        .select()
        .from(exceptionsTable)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(sql`CASE ${exceptionsTable.severity} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`, desc(exceptionsTable.createdAt))
        .limit(query.limit);
      return { items: rows.map(exceptionView) };
    });

    scope.post<{ Params: { id: string } }>('/api/exceptions/:id', async (req): Promise<ExceptionItem> => {
      const id = requireUuid(req.params.id, 'exception_not_found');
      const input = parseBody(ExceptionResolveInput, req.body);
      const { db, clock } = req.server.fos;
      const now = clock.now();
      const patch =
        input.action === 'snooze'
          ? { status: 'snoozed' as const, snoozedUntil: new Date(now.getTime() + (input.snoozeDays ?? 7) * 86_400_000), resolution: input.note, updatedAt: now }
          : input.action === 'reopen'
            ? { status: 'open' as const, snoozedUntil: null, resolvedAt: null, resolvedBy: null, resolution: input.note, updatedAt: now }
            : {
                status: input.action === 'dismiss' ? ('dismissed' as const) : ('resolved' as const),
                resolution: input.note,
                resolvedAt: now,
                resolvedBy: 'owner',
                snoozedUntil: null,
                updatedAt: now,
              };
      if (input.action === 'snooze' && input.snoozeDays === undefined) throw errors.badRequest('Snoozing needs a number of days.');
      const [row] = await db.update(exceptionsTable).set(patch).where(eq(exceptionsTable.id, id)).returning();
      if (!row) throw errors.notFound('exception_not_found', 'Inbox item not found.');
      await audit(req, `exception.${input.action}`, { type: 'exception', id }, `Inbox item ${input.action}: ${row.kind}`);
      return exceptionView(row);
    });
  });
}
