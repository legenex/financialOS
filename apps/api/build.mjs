// Bundles the API server and operations CLI into single ESM files.
//   node build.mjs  ->  dist/main.mjs, dist/cli.mjs
// Packages with native bindings or runtime migrations stay external; they are production
// dependencies of @financialos/api and are copied into the image next to the bundle.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const external = ['@node-rs/argon2', 'pg-boss'];
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
  // Release version only; no environment values are inlined.
  define: { __FOS_VERSION__: JSON.stringify(process.env.FOS_RELEASE_VERSION || pkg.version) },
  // Some bundled CommonJS dependencies call require(); provide it in the ESM output.
  banner: {
    js: "import { createRequire as __fosCreateRequire } from 'node:module'; const require = __fosCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
