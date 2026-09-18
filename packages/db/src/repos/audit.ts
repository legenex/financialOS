import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import type { AuditEvent } from '@financialos/contracts';
import { auditEvents, type AuditActorType } from '../schema/security';
import { clampLimit, decodeCursor, encodeCursor, iso, type DbOrTx } from './_util';

export type AuditEventRow = typeof auditEvents.$inferSelect;

export interface AuditInput {
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  objectType?: string | null;
  objectId?: string | null;
  entityId?: string | null;
  summary: string;
  /** Must never contain secrets or raw financial data; callers redact first. */
  details?: Record<string, unknown>;
  requestId?: string | null;
  ipHash?: string | null;
}

/** Appends an audit event. The table is append-only. */
export async function appendAudit(db: DbOrTx, event: AuditInput): Promise<AuditEventRow> {
  const [row] = await db
    .insert(auditEvents)
    .values({
      actorType: event.actorType,
      actorId: event.actorId ?? null,
      action: event.action,
      objectType: event.objectType ?? null,
      objectId: event.objectId ?? null,
      entityId: event.entityId ?? null,
      summary: event.summary,
      details: event.details ?? {},
      requestId: event.requestId ?? null,
      ipHash: event.ipHash ?? null,
    })
    .returning();
  if (!row) throw new Error('audit insert returned no row');
  return row;
}

export interface AuditQuery {
  cursor?: string | null;
  limit?: number;
  objectType?: string;
  objectId?: string;
  entityId?: string;
  action?: string;
}

export async function listAudit(db: DbOrTx, query: AuditQuery = {}): Promise<{ items: AuditEventRow[]; nextCursor: string | null }> {
  const limit = clampLimit(query.limit, 50, 200);
  const conditions: SQL[] = [];
  if (query.objectType) conditions.push(eq(auditEvents.objectType, query.objectType));
  if (query.objectId) conditions.push(eq(auditEvents.objectId, query.objectId));
  if (query.entityId) conditions.push(eq(auditEvents.entityId, query.entityId));
  if (query.action) conditions.push(eq(auditEvents.action, query.action));
  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    const at = new Date(cursor.at);
    const id = Number(cursor.id);
    const keyset = or(lt(auditEvents.occurredAt, at), and(eq(auditEvents.occurredAt, at), lt(auditEvents.id, id)));
    if (keyset) conditions.push(keyset);
  }
  const rows = await db
    .select()
    .from(auditEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.occurredAt, last.id) : null };
}

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: String(row.id),
    occurredAt: iso(row.occurredAt),
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    summary: row.summary,
  };
}
