#!/usr/bin/env node
// Copies the production packages that bundled server entry points still import at runtime
// (esbuild "external" packages such as native bindings), plus their transitive dependencies.
//
//   node deploy/docker/copy-externals.mjs --root <repo> --out <dir> <distDir> [<distDir> ...]
//
// The output mirrors the repository layout (<out>/node_modules/..., <out>/apps/x/node_modules/...), so it can be
// copied over /app in the runtime image. A manifest of copied packages is written to
// <out>/runtime-externals.json.
//
// The scan looks for static and dynamic import/require specifiers in the bundled files. It fails when an
// external resolves to a workspace package (those must be bundled) or to a devDependency, and when a required
// transitive dependency is missing from node_modules.

import { builtinModules } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let root = process.cwd();
let out = '';
const distDirs = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--root') root = path.resolve(args[(i += 1)]);
  else if (arg === '--out') out = path.resolve(args[(i += 1)]);
  else if (arg === '-h' || arg === '--help') {
    console.log('usage: copy-externals.mjs --root <repo> --out <dir> <distDir>...');
    process.exit(0);
  } else distDirs.push(path.resolve(arg));
}
if (!out || distDirs.length === 0) {
  console.error('usage: copy-externals.mjs --root <repo> --out <dir> <distDir>...');
  process.exit(2);
}

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"'\s]+)["']/g,
  /\bimport\s*["']([^"'\s]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\s]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\s]+)["']\s*\)/g,
  /\brequire\.resolve\s*\(\s*["']([^"'\s]+)["']/g,
];

const lockPath = path.join(root, 'package-lock.json');
const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : { packages: {} };

function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return null;
  if (builtins.has(specifier) || builtins.has(specifier.split('/')[0])) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return PACKAGE_NAME.test(name) ? name : null;
}

function listFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...listFiles(full));
    } else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A conflicting version can force npm to hoist a *different* package's copy of `name` to the
 * repo root (for example a devDependency's old major version), shadowing the real one further
 * down the tree. When that happens, prefer a nested, non-dev copy actually reachable from a
 * production dependency over the naive upward walk's hoisted match.
 */
function findNestedNonDevCopy(name) {
  const suffix = `/node_modules/${name}`;
  const matches = Object.keys(lock.packages ?? {})
    .filter((p) => p.endsWith(suffix))
    .filter((p) => !(lock.packages[p].dev === true && lock.packages[p].optional !== true))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  const match = matches[0];
  return match ? path.join(root, ...match.split('/')) : null;
}

function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      const rel = path.relative(root, candidate).split(path.sep).join('/');
      const lockEntry = lock.packages?.[rel];
      if (lockEntry?.dev === true && lockEntry?.optional !== true) {
        return findNestedNonDevCopy(name) ?? candidate;
      }
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir || !isInside(parent, root)) return null;
    dir = parent;
  }
}

const errors = [];
const warnings = [];
const copied = new Map();

function visit(pkgDir, requestedBy) {
  const rel = path.relative(root, pkgDir);
  if (copied.has(rel)) return;
  const stat = fs.lstatSync(pkgDir);
  const real = fs.realpathSync(pkgDir);
  if (stat.isSymbolicLink() || !real.includes(`${path.sep}node_modules${path.sep}`)) {
    errors.push(`${rel} (needed by ${requestedBy}) is a workspace link; bundle it instead of marking it external`);
    return;
  }
  const lockEntry = lock.packages?.[rel.split(path.sep).join('/')];
  if (lockEntry?.dev === true && lockEntry?.optional !== true) {
    errors.push(`${rel} (needed by ${requestedBy}) is a devDependency and is not installed in production`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  copied.set(rel, { name: manifest.name, version: manifest.version, requestedBy });
  const required = Object.keys(manifest.dependencies ?? {});
  const optional = [
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
  for (const dep of required) {
    const found = findPackageDir(dep, pkgDir);
    if (found) visit(found, manifest.name);
    else if (!optional.includes(dep)) errors.push(`${dep} (dependency of ${manifest.name}) is missing from node_modules`);
  }
  for (const dep of optional) {
    const found = findPackageDir(dep, pkgDir);
    if (found) visit(found, manifest.name);
  }
}

for (const distDir of distDirs) {
  if (!fs.existsSync(distDir)) {
    errors.push(`bundle directory not found: ${path.relative(root, distDir)}`);
    continue;
  }
  const workspaceDir = path.dirname(distDir);
  const names = new Set();
  for (const file of listFiles(distDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const name = packageNameOf(match[1]);
        if (name) names.add(name);
      }
    }
  }
  for (const name of [...names].sort()) {
    const found = findPackageDir(name, workspaceDir);
    if (found) visit(found, path.relative(root, distDir));
    else warnings.push(`${name} is referenced in ${path.relative(root, distDir)} but not installed; assuming it is not a runtime import`);
  }
}

for (const w of warnings) console.warn(`copy-externals: warning: ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`copy-externals: error: ${e}`);
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
for (const rel of [...copied.keys()].sort()) {
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(root, rel), dest, { recursive: true, verbatimSymlinks: true });
}
const manifest = [...copied.entries()]
  .map(([rel, info]) => ({ path: rel.split(path.sep).join('/'), ...info }))
  .sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(path.join(out, 'runtime-externals.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`copy-externals: copied ${manifest.length} package(s)`);
for (const m of manifest) console.log(`  ${m.path}@${m.version}`);
