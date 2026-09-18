import type { Database } from '@financialos/db';
import type { Keyring } from '@financialos/security/crypto';
import type { Logger } from 'pino';
import type { WorkerConfig } from '../config';

export interface JobContext {
  db: Database;
  config: WorkerConfig;
  logger: Logger;
  keyring: Keyring;
}

/**
 * What a handler reports back. `ok` means the handler did real work and it succeeded.
 * `not_configured` / `skipped` mean the handler correctly determined there was nothing it could
 * do (missing provider, missing credential, nothing due) — this is a successful job outcome, not
 * a crash, and pg-boss should not retry it.  Handlers signal a genuine failure by throwing, which
 * lets pg-boss's retry/backoff and dead-letter policy do its job.
 */
export interface JobOutcome {
  status: 'ok' | 'not_configured' | 'skipped';
  summary: string;
  detail?: Record<string, unknown>;
}
