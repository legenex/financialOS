import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { AgentClient, AgentScope } from '@financialos/contracts';
import { agentClients } from '../schema/security';
import { addDaysTo, iso, type DbOrTx } from './_util';

export type AgentClientRow = typeof agentClients.$inferSelect;

export async function createAgentClient(
  db: DbOrTx,
  input: { name: string; credentialHash: string; scopes: AgentScope[]; entityIds: string[]; expiresInDays: number; now?: Date },
): Promise<AgentClientRow> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(agentClients)
    .values({
      name: input.name,
      credentialHash: input.credentialHash,
      scopes: [...new Set(input.scopes)],
      entityIds: [...new Set(input.entityIds)],
      createdAt: now,
      expiresAt: addDaysTo(now, input.expiresInDays),
    })
    .returning();
  if (!row) throw new Error('agent client insert returned no row');
  return row;
}

export async function listAgentClients(db: DbOrTx): Promise<AgentClientRow[]> {
  return db.select().from(agentClients).orderBy(desc(agentClients.createdAt));
}

export async function getAgentClient(db: DbOrTx, id: string): Promise<AgentClientRow | null> {
  const [row] = await db.select().from(agentClients).where(eq(agentClients.id, id)).limit(1);
  return row ?? null;
}

export async function findActiveAgentClientByCredentialHash(
  db: DbOrTx,
  credentialHash: string,
  now = new Date(),
): Promise<AgentClientRow | null> {
  const [row] = await db
    .select()
    .from(agentClients)
    .where(and(eq(agentClients.credentialHash, credentialHash), isNull(agentClients.revokedAt), gt(agentClients.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

export async function touchAgentClient(db: DbOrTx, id: string, now = new Date()): Promise<void> {
  await db.update(agentClients).set({ lastUsedAt: now }).where(eq(agentClients.id, id));
}

export async function revokeAgentClient(db: DbOrTx, id: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(agentClients)
    .set({ revokedAt: now })
    .where(and(eq(agentClients.id, id), isNull(agentClients.revokedAt)))
    .returning({ id: agentClients.id });
  return rows.length > 0;
}

export function toAgentClient(row: AgentClientRow): AgentClient {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes as AgentScope[],
    entityIds: row.entityIds,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
  };
}
