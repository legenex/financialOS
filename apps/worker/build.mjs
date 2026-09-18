// Bundles the worker process and operations CLI into single ESM files.
//   node build.mjs  ->  dist/main.mjs, dist/cli.mjs
// pg-boss stays external; it is a production dependency of @financialos/worker and is copied into
// the image next to the bundle (see deploy/docker/copy-externals.mjs).
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const external = ['pg-boss'];
for (const name of external) {
  if (!pkg.dependencies?.[name]) throw new Error(`external package ${name} must be a production dependency`);
}

rmSync(join(here, 'dist'), { recursive: true, force: true });

await build({
  absWorkingDir: here,
  entryPoints: { main: 'src/main.ts', cli: 'src/cli.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  external,
  define: { __FOS_VERSION__: JSON.stringify(process.env.FOS_RELEASE_VERSION || pkg.version) },
  banner: {
    js: "import { createRequire as __fosCreateRequire } from 'node:module'; const require = __fosCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
