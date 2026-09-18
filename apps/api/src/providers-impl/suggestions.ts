/**
 * The only write an agent can perform: a classification suggestion.
 *
 * It never touches a classification. It opens an item of kind `agent_suggestion` in the owner's
 * exception inbox, with the agent named and the suggestion recorded as data, for the owner to accept
 * or dismiss. Document and provider text reaching us this way is data, never an instruction.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { accounts as accountsTable, exceptions as exceptionsTable, sourceRecords } from '@financialos/db';
import type { AppContext } from '../context';
import { ProviderUnavailableError, type AgentCallContext, type ClassificationSuggestionInput, type SuggestionSink } from '../providers';

export class DbSuggestionSink implements SuggestionSink {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async createAgentSuggestion(call: AgentCallContext, input: ClassificationSuggestionInput): Promise<{ exceptionId: string }> {
    const { db, clock } = this.#ctx;
    const [record] = await db
      .select({ id: sourceRecords.id, description: sourceRecords.description, accountId: sourceRecords.accountId, entityId: accountsTable.legalEntityId })
      .from(sourceRecords)
      .innerJoin(accountsTable, eq(sourceRecords.accountId, accountsTable.id))
      .where(and(eq(sourceRecords.id, input.transactionId), inArray(accountsTable.legalEntityId, [...call.entityIds])))
      .limit(1);
    if (!record) {
      // Same answer whether the transaction is missing or out of scope: nothing is disclosed.
      throw new ProviderUnavailableError('That transaction is not available to this credential.');
    }
    const now = clock.now();
    const dedupeKey = `agent_suggestion:${input.transactionId}:${call.clientId}`;
    const values = {
      dedupeKey,
      kind: 'agent_suggestion' as const,
      severity: 'info' as const,
      status: 'open' as const,
      title: `${call.clientName} suggests a classification`,
      body: `${call.clientName} suggests classifying "${record.description ?? 'this transaction'}" as ${input.nature} (confidence ${input.confidence}). Reason given: ${input.rationale}`,
      subjectType: 'transaction',
      subjectId: input.transactionId,
      subjectLabel: record.description,
      entityId: record.entityId,
      detail: {
        suggestedNature: input.nature,
        suggestedCategoryId: input.categoryId,
        confidence: input.confidence,
        agentClientId: call.clientId,
        // The agent's words are stored as data; they are never executed or treated as instructions.
        rationale: input.rationale,
      },
      suggestedActions: [
        { id: 'accept', label: 'Open the transaction and classify it', href: `/money/transactions/${input.transactionId}` },
        { id: 'dismiss', label: 'Dismiss the suggestion', href: null },
      ],
      source: `agent:${call.clientId}`,
      lastSeenAt: now,
    };
    const [row] = await db
      .insert(exceptionsTable)
      .values(values)
      .onConflictDoUpdate({
        target: exceptionsTable.dedupeKey,
        set: { title: values.title, body: values.body, detail: values.detail, lastSeenAt: now, updatedAt: now },
      })
      .returning({ id: exceptionsTable.id });
    if (!row) throw new Error('agent suggestion upsert returned no row');
    await this.#ctx.audit.record({
      actorType: 'agent',
      actorId: call.clientId,
      action: 'agent.classification_suggested',
      object: { type: 'transaction', id: input.transactionId },
      entityId: record.entityId,
      summary: `Agent suggested a classification (${input.nature}); an inbox item was opened`,
      details: { exceptionId: row.id, nature: input.nature, confidence: input.confidence },
    });
    return { exceptionId: row.id };
  }
}
