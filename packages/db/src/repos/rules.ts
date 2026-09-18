/**
 * Declarative classification rules.
 *
 * `match` holds the domain rule's conditions, kind and confidence; `action` holds what the
 * rule sets. Both are validated with `validateRule` from `@financialos/domain` before they
 * are stored, so a rule that could never be applied — or one that would infer ownership from
 * currency alone — is never saved.
 */
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { orderRules, validateRule, type ClassificationRule, type RuleActions, type RuleCondition } from '@financialos/domain';
import { rules } from '../schema/sources';
import { InvalidError, mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type RuleRow = typeof rules.$inferSelect;

export interface RuleMatch {
  conditions: RuleCondition[];
  /** `ownership` rules decide the economic owner and outrank general rules. */
  kind?: 'general' | 'ownership';
  confidence?: 'high' | 'medium' | 'low';
}

export interface CreateRuleInput {
  name: string;
  match: RuleMatch;
  action: RuleActions;
  priority?: number;
  active?: boolean;
  entityId?: string | null;
  accountId?: string | null;
  createdFrom?: string;
}

function toDomainRule(id: string, input: { name: string; priority: number; active: boolean; match: RuleMatch; action: RuleActions }): ClassificationRule {
  return {
    id,
    name: input.name,
    enabled: input.active,
    priority: input.priority,
    kind: input.match.kind ?? 'general',
    conditions: input.match.conditions,
    actions: input.action,
    confidence: input.match.confidence ?? 'medium',
  };
}

function assertValid(rule: ClassificationRule): void {
  const problems = validateRule(rule);
  if (problems.length > 0) throw new InvalidError(`Rule is not valid: ${problems.join('; ')}`);
}

export async function create(db: DbOrTx, input: CreateRuleInput): Promise<RuleRow> {
  const priority = input.priority ?? 100;
  const active = input.active ?? true;
  assertValid(toDomainRule('draft', { name: input.name, priority, active, match: input.match, action: input.action }));
  return mapErrors('create rule', async () => {
    const [row] = await db
      .insert(rules)
      .values({
        name: input.name,
        priority,
        active,
        match: input.match as unknown as Record<string, unknown>,
        action: input.action as unknown as Record<string, unknown>,
        entityId: input.entityId ?? null,
        accountId: input.accountId ?? null,
        createdFrom: input.createdFrom ?? 'user',
      })
      .returning();
    return required(row, 'rule');
  });
}

export async function update(db: DbOrTx, id: string, patch: Partial<CreateRuleInput>): Promise<RuleRow> {
  const current = required(await getById(db, id), 'rule');
  assertValid(
    toDomainRule(id, {
      name: patch.name ?? current.name,
      priority: patch.priority ?? current.priority,
      active: patch.active ?? current.active,
      match: (patch.match ?? current.match) as unknown as RuleMatch,
      action: (patch.action ?? current.action) as unknown as RuleActions,
    }),
  );
  return mapErrors('update rule', async () => {
    const [row] = await db.update(rules).set(pickDefined(patch)).where(eq(rules.id, id)).returning();
    return required(row, 'rule');
  });
}

export async function setActive(db: DbOrTx, id: string, active: boolean): Promise<RuleRow> {
  const [row] = await db.update(rules).set({ active }).where(eq(rules.id, id)).returning();
  return required(row, 'rule');
}

/** Deleting a rule leaves earlier classifications and their `ruleId` history untouched. */
export async function remove(db: DbOrTx, id: string): Promise<boolean> {
  return mapErrors('delete rule', async () => {
    const rows = await db.delete(rules).where(eq(rules.id, id)).returning({ id: rules.id });
    return rows.length > 0;
  });
}

export async function getById(db: DbOrTx, id: string): Promise<RuleRow | undefined> {
  const [row] = await db.select().from(rules).where(eq(rules.id, id)).limit(1);
  return row;
}

export async function list(db: DbOrTx, query: { active?: boolean; entityId?: string; accountId?: string } = {}): Promise<RuleRow[]> {
  const conditions: SQL[] = [];
  if (query.active !== undefined) conditions.push(eq(rules.active, query.active));
  if (query.entityId) conditions.push(eq(rules.entityId, query.entityId));
  if (query.accountId) conditions.push(eq(rules.accountId, query.accountId));
  return db
    .select()
    .from(rules)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(rules.priority), desc(rules.createdAt));
}

export function toRule(row: RuleRow): ClassificationRule {
  return toDomainRule(row.id, {
    name: row.name,
    priority: row.priority,
    active: row.active,
    match: row.match as unknown as RuleMatch,
    action: row.action as unknown as RuleActions,
  });
}

/** Active rules as domain `ClassificationRule`s, already in evaluation order. */
export async function loadForClassification(db: DbOrTx, query: { entityId?: string; accountId?: string } = {}): Promise<ClassificationRule[]> {
  const rows = await list(db, { ...query, active: true });
  return orderRules(rows.map(toRule));
}

/** Records that rules fired, so unused rules are visible to the owner. */
export async function recordHits(db: DbOrTx, ruleIds: readonly string[], now = new Date()): Promise<void> {
  const counts = new Map<string, number>();
  for (const id of ruleIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, hits] of counts) {
    await db
      .update(rules)
      .set({ hitCount: sql`${rules.hitCount} + ${hits}`, lastHitAt: now })
      .where(eq(rules.id, id));
  }
}
