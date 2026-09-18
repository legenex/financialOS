import type { FastifyRequest } from 'fastify';
import { auditEvents, type AuditActorType, type DbOrTx } from '@financialos/db';
import { hmacSha256 } from '@financialos/security/tokens';
import { redactText, redactValue } from '@financialos/security/redact';
import type { Clock } from '../clock';

export interface AuditObject {
  type: string;
  id?: string | null;
}

export interface AuditEntry {
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  object?: AuditObject | null;
  entityId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
  requestId?: string | null;
  ipHash?: string | null;
}

/** Keyed hash of a client address. Addresses are never stored in clear. */
export function hashClientIp(pepper: Buffer, ip: string | undefined): string | null {
  if (!ip) return null;
  return hmacSha256(pepper, `ip:${ip}`).toString('hex').slice(0, 32);
}

/** Who is acting on this request, from the principal the guards attached. */
export function actorOf(req: FastifyRequest): { actorType: AuditActorType; actorId: string | null } {
  if (req.session) return { actorType: 'owner', actorId: `session:${req.session.id}` };
  if (req.agent) return { actorType: 'agent', actorId: req.agent.id };
  if (req.device) return { actorType: 'device', actorId: req.device.id };
  return { actorType: 'anonymous', actorId: null };
}

/**
 * Append-only audit trail. Summaries and details are scrubbed of secrets before storage;
 * callers still pass identifiers and outcomes only, never credentials or financial values.
 */
export class AuditService {
  readonly #db: DbOrTx;
  readonly #clock: Clock;
  readonly #pepper: Buffer;

  constructor(db: DbOrTx, clock: Clock, pepper: Buffer) {
    this.#db = db;
    this.#clock = clock;
    this.#pepper = pepper;
  }

  async record(entry: AuditEntry, tx?: DbOrTx): Promise<void> {
    const details = (redactValue(entry.details ?? {}) ?? {}) as Record<string, unknown>;
    await (tx ?? this.#db).insert(auditEvents).values({
      occurredAt: this.#clock.now(),
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      objectType: entry.object?.type ?? null,
      objectId: entry.object?.id ?? null,
      entityId: entry.entityId ?? null,
      summary: redactText(entry.summary).slice(0, 500),
      details,
      requestId: entry.requestId ?? null,
      ipHash: entry.ipHash ?? null,
    });
  }

  /** `audit(req, action, object, summary, details)` */
  async fromRequest(
    req: FastifyRequest,
    action: string,
    object: AuditObject | null,
    summary: string,
    details: Record<string, unknown> = {},
    tx?: DbOrTx,
  ): Promise<void> {
    const actor = actorOf(req);
    await this.record(
      {
        ...actor,
        action,
        object,
        summary,
        details,
        requestId: String(req.id),
        ipHash: hashClientIp(this.#pepper, req.ip),
      },
      tx,
    );
  }
}

/** Shorthand used by route modules: `await audit(req, 'export.csv', { type: 'transactions' }, 'Exported transactions')`. */
export function audit(
  req: FastifyRequest,
  action: string,
  object: AuditObject | null,
  summary: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  return req.server.fos.audit.fromRequest(req, action, object, summary, details);
}
