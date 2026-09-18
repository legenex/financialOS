import { createDb, type DbHandle } from '@financialos/db';
import type { WorkerConfig } from './config';
import { readSecretFile } from './secrets';

/** Connects as the worker's configured database role (FOS_DATABASE_ROLE=worker by default). */
export function connectDb(config: WorkerConfig, applicationName = 'financialos-worker'): DbHandle {
  const password = config.database.passwordFile ? readSecretFile(config.database.passwordFile, 'database password') : undefined;
  return createDb({
    url: config.database.url,
    ...(password !== undefined ? { password } : {}),
    applicationName,
    max: 5,
  });
}
