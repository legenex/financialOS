import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

// Resolve paths from this file so the config works from the repo root and from packages/db.
// drizzle-kit mishandles absolute `out` paths, so both paths are made relative to the working directory.
const here = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const rel = (p: string) => path.relative(process.cwd(), path.join(here, p)) || '.';

export default defineConfig({
  dialect: 'postgresql',
  schema: rel('src/schema/index.ts'),
  out: rel('migrations'),
  strict: true,
  verbose: true,
  migrations: { table: '__drizzle_migrations', schema: 'drizzle' },
});
