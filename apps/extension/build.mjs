#!/usr/bin/env node
// Builds the "FinancialOS New Tab" Chrome extension.
//
//   node build.mjs          -> dist/ (load unpacked)
//   node build.mjs --zip    -> dist/ plus release/financialos-newtab-<version>.zip and .sha256
//
// The build is fully local: every script, stylesheet, font, and icon ships inside the package.
// It fails when the output contains eval-like code, remote URLs outside a short documented
// allowlist, inline scripts or styles, or a manifest that drifts from the restricted policy.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, '..', '..');

export const REQUIRED_PERMISSIONS = ['storage'];
export const OPTIONAL_HOST_PERMISSIONS = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];
export const ICON_SIZES = [16, 32, 48, 128];

/**
 * URL literals that may appear in bundled JavaScript. None of them is ever requested:
 *  - json-schema.org identifiers are `$schema` values inside zod's JSON Schema support;
 *  - `http://[${...}]` is a template zod uses to validate IPv6 URL hosts;
 *  - the SVG namespace identifies inline SVG elements created with createElementNS.
 */
export const ALLOWED_URL_LITERALS = [
  /^https?:\/\/json-schema\.org\/draft[-/0-9a-z]*\/schema#?$/,
  /^http:\/\/\[\$\{[A-Za-z_$][\w$]*\}\]$/,
  /^http:\/\/www\.w3\.org\/2000\/svg$/,
];

/** A dotted DNS name, an IPv4 literal, or a bracketed IPv6 literal, with an optional port. */
const PLAUSIBLE_HOST =
  /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;
/** On-host addresses: reachable only from this computer, and only with the owner's permission. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
/** Reserved documentation names (RFC 2606 / RFC 6761). They resolve nowhere. */
const DOCUMENTATION_HOST = /(?:^|\.)(?:example\.test|invalid)(?::\d{1,5})?$/i;

/**
 * Whether a `http(s)://…` literal found in bundled JavaScript is acceptable.
 *
 * The extension builds every request from the origin the owner configured (src/lib/origin.ts), so
 * a bundled literal must never name a reachable third party. Accepted: the documented zod and SVG
 * identifiers above; bare scheme prefixes and prose such as "Use https://."; template literals
 * whose authority is a placeholder; loopback addresses; and reserved documentation names used in
 * placeholder text. Anything that resolves to a real remote host fails the build.
 */
export function isAllowedUrlLiteral(literal) {
  if (ALLOWED_URL_LITERALS.some((re) => re.test(literal))) return true;
  const authority = /^https?:\/\/([^/?#]*)/.exec(literal)?.[1] ?? '';
  if (authority === '') return true;
  if (authority.includes('${')) return true;
  if (LOOPBACK_HOST.test(authority)) return true;
  if (!PLAUSIBLE_HOST.test(authority)) return true;
  return DOCUMENTATION_HOST.test(authority);
}

/** Chrome extension ID: first 128 bits of SHA-256(SPKI DER public key), hex digits 0-f mapped to a-p. */
export function extensionIdFromPublicKey(publicKeyBase64) {
  const der = Buffer.from(publicKeyBase64, 'base64');
  if (der.length < 64) throw new Error('manifest key is missing or too short; run `node scripts/init-key.mjs`');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(c, 16))).join('');
}

/** Parses a CSP string into a map of directive -> source list. */
export function parseCsp(policy) {
  const out = new Map();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/** Returns a list of policy violations for a manifest object. Empty means compliant. */
export function checkManifest(manifest) {
  const problems = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (!same(manifest.permissions, REQUIRED_PERMISSIONS)) problems.push('permissions must be exactly ["storage"]');
  if (!same(manifest.optional_host_permissions, OPTIONAL_HOST_PERMISSIONS))
    problems.push('optional_host_permissions drifted');
  for (const key of [
    'host_permissions',
    'content_scripts',
    'background',
    'optional_permissions',
    'web_accessible_resources',
    'declarative_net_request',
    'devtools_page',
    'sandbox',
    'side_panel',
    'action',
    'commands',
    'oauth2',
    'update_url',
  ]) {
    if (key in manifest) problems.push(`${key} must not be declared`);
  }
  if (manifest.chrome_url_overrides?.newtab !== 'newtab.html') problems.push('newtab override must be newtab.html');
  if (Object.keys(manifest.chrome_url_overrides ?? {}).length !== 1)
    problems.push('only the newtab override is allowed');
  if (manifest.options_page !== 'options.html') problems.push('options_page must be options.html');
  if (!same(manifest.externally_connectable, { ids: [] })) problems.push('externally_connectable must be { ids: [] }');
  if (typeof manifest.key !== 'string' || manifest.key.length < 300)
    problems.push('key must be the base64 SPKI public key');
  const policy = manifest.content_security_policy?.extension_pages;
  if (typeof policy !== 'string') {
    problems.push('content_security_policy.extension_pages is required');
  } else {
    const csp = parseCsp(policy);
    if (!same(csp.get('script-src'), ["'self'"])) problems.push("script-src must be exactly 'self'");
    if (!same(csp.get('object-src'), ["'self'"]) && !same(csp.get('object-src'), ["'none'"]))
      problems.push("object-src must be 'self' or 'none'");
    if (!same(csp.get('base-uri'), ["'none'"])) problems.push("base-uri must be 'none'");
    if (!same(csp.get('frame-ancestors'), ["'none'"])) problems.push("frame-ancestors must be 'none'");
    if (!same(csp.get('default-src'), ["'self'"])) problems.push("default-src must be 'self'");
    for (const directive of ['worker-src', 'script-src-elem', 'script-src-attr']) {
      if (csp.has(directive)) problems.push(`${directive} must not be declared`);
    }
    if (/unsafe-(eval|inline|hashes)|wasm-unsafe-eval|strict-dynamic|nonce-|sha(256|384|512)-/i.test(policy)) {
      problems.push('CSP must not relax script execution');
    }
    const connect = csp.get('connect-src') ?? [];
    for (const source of connect) {
      if (!['https:', 'http://localhost:*', 'http://127.0.0.1:*'].includes(source))
        problems.push(`connect-src source not allowed: ${source}`);
    }
  }
  return problems;
}

export function createManifest(template, { version }) {
  if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`invalid extension version ${version}`);
  const { manifest_version, name, short_name, ...rest } = template;
  const manifest = { manifest_version, name, short_name, version, ...rest };
  const problems = checkManifest(manifest);
  if (problems.length) throw new Error(`manifest policy violations:\n  - ${problems.join('\n  - ')}`);
  return manifest;
}

/** Scans bundled JavaScript for forbidden constructs. Returns human-readable findings. */
export function scanJs(text) {
  const findings = [];
  const rules = [
    [/\beval\s*\(/, 'eval('],
    [/\bnew\s+Function\b/, 'new Function'],
    [/(?<![\w$.])Function\s*\(/, 'Function('],
    [/\b(?:setTimeout|setInterval)\s*\(\s*["'`]/, 'string timer'],
    [/\bdocument\.write\b/, 'document.write'],
    [/\.(?:innerHTML|outerHTML)\s*=(?!=)/, 'innerHTML/outerHTML assignment'],
    [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
    [/\bimportScripts\b/, 'importScripts'],
    [/\bchrome\.storage\.sync\b|\bstorage\.sync\b/, 'storage.sync usage'],
    [/\bonMessageExternal\b|\bonConnectExternal\b/, 'external messaging listener'],
    [/<script\b/i, 'script tag string'],
  ];
  for (const [re, label] of rules) if (re.test(text)) findings.push(label);
  for (const match of text.matchAll(/https?:\/\/[^\s"'`)<>\\,;]*/g)) {
    if (!isAllowedUrlLiteral(match[0])) findings.push(`remote URL literal ${match[0]}`);
  }
  return findings;
}

export function scanHtml(text) {
  const findings = [];
  if (/<style\b/i.test(text)) findings.push('inline <style>');
  if (/\sstyle\s*=/i.test(text)) findings.push('style attribute');
  if (/\son[a-z]+\s*=/i.test(text)) findings.push('inline event handler');
  if (/javascript:/i.test(text)) findings.push('javascript: URL');
  if (/<base\b/i.test(text)) findings.push('<base> element');
  if (/(?:https?:)?\/\/[a-z0-9]/i.test(text.replace(/<!--[\s\S]*?-->/g, '')))
    findings.push('remote or protocol-relative URL');
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? '';
    if ((m[2] ?? '').trim()) findings.push('inline script');
    const src = /\ssrc="([^"]+)"/.exec(attrs)?.[1];
    if (!src) findings.push('script without src');
    else if (!/^[a-z0-9_./-]+\.js$/i.test(src) || src.includes('..')) findings.push(`script src not local: ${src}`);
  }
  return findings;
}

/**
 * SVG is a document format: it can carry script, event handlers, and references to other files.
 * The icons this package ships must be static drawings, with no reference outside themselves.
 */
export function scanSvg(text) {
  const findings = [];
  if (/<script\b/i.test(text)) findings.push('script element in SVG');
  if (/<foreignObject\b/i.test(text)) findings.push('foreignObject in SVG');
  if (/<(?:image|use)\b/i.test(text)) findings.push('external reference element in SVG');
  if (/\son[a-z]+\s*=/i.test(text)) findings.push('inline event handler in SVG');
  if (/javascript:/i.test(text)) findings.push('javascript: URL in SVG');
  for (const match of text.matchAll(/(?:xlink:href|href|src)\s*=\s*(['"])(.*?)\1/gi)) {
    const target = match[2] ?? '';
    // Only same-document references (gradients, clip paths) are allowed.
    if (!target.startsWith('#')) findings.push(`non-local reference in SVG: ${target}`);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'`)<>\\,;]*/g)) {
    if (!isAllowedUrlLiteral(match[0])) findings.push(`remote URL literal ${match[0]}`);
  }
  return findings;
}

export function scanCss(text) {
  const findings = [];
  if (/@import\b/i.test(text)) findings.push('@import in output CSS');
  for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const target = m[2] ?? '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) findings.push(`non-local url(): ${target}`);
  }
  if (/expression\s*\(/i.test(text)) findings.push('CSS expression');
  return findings;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function resolveTokensCss() {
  const shared = path.join(repoRoot, 'packages/ui/src/tokens.css');
  const fallback = path.join(appDir, 'src/styles/tokens.css');
  if (existsSync(shared)) {
    const text = readFileSync(shared, 'utf8');
    const issues = scanCss(text);
    if (!issues.length) return { text, source: 'packages/ui/src/tokens.css' };
    console.warn(
      `build: packages/ui tokens not self-contained (${issues.join(', ')}); using the extension fallback tokens`,
    );
  }
  return { text: readFileSync(fallback, 'utf8'), source: 'apps/extension/src/styles/tokens.css' };
}

/** Brand assets come from the shared identity in packages/ui/assets, with a local copy as fallback. */
function resolveAsset(name) {
  const shared = path.join(repoRoot, 'packages/ui/assets', name);
  if (existsSync(shared)) return { file: shared, source: 'packages/ui/assets' };
  const local = path.join(appDir, 'public/icons', name);
  if (existsSync(local)) return { file: local, source: 'apps/extension/public/icons' };
  throw new Error(`brand asset ${name} not found in packages/ui/assets or apps/extension/public/icons`);
}

/**
 * esbuild plugin:
 *  - resolves `@financialos/contracts` to the extension contract module only, so the bundle does
 *    not carry every API schema;
 *  - rewrites the contracts' `import { z } from 'zod'` into a namespace import, which lets esbuild
 *    drop the parts of zod the extension never calls (all locales, JSON Schema import, compiler).
 */
function contractsPlugin() {
  const contractsDir = path.join(repoRoot, 'packages/contracts/src');
  return {
    name: 'financialos-contracts',
    setup(b) {
      b.onResolve({ filter: /^@financialos\/contracts$/ }, () => ({ path: path.join(contractsDir, 'extension.ts') }));
      b.onLoad({ filter: /packages[\\/]contracts[\\/]src[\\/].*\.ts$/ }, (args) => {
        const source = readFileSync(args.path, 'utf8');
        const rewritten = source.replace(/^import \{ z \} from 'zod';$/m, "import * as z from 'zod';");
        if (/from 'zod'/.test(source) && !/import \* as z from 'zod';/.test(rewritten)) {
          throw new Error(`${args.path}: unexpected zod import form; update the contracts plugin in build.mjs`);
        }
        return { contents: rewritten, loader: 'ts' };
      });
    },
  };
}

const THIRD_PARTY_NOTICES = (
  zodLicense,
  interLicense,
) => `FinancialOS New Tab bundles the following third-party software.

================================================================
zod (MIT License) - schema validation
================================================================
${zodLicense.trim()}

================================================================
Inter variable font (SIL Open Font License 1.1)
================================================================
${interLicense.trim()}
`;

/** Deterministic ZIP: sorted entries, fixed timestamps and attributes. */
export async function createDeterministicZip(distDir) {
  const { zipSync } = await import('fflate');
  const files = walk(distDir)
    .map((file) => path.relative(distDir, file).split(path.sep).join('/'))
    .sort();
  // fflate writes DOS timestamps from local-time fields, so construct the date from local fields.
  const mtime = new Date(1980, 0, 1, 0, 0, 0);
  const entries = {};
  for (const rel of files) {
    entries[rel] = [
      new Uint8Array(readFileSync(path.join(distDir, rel))),
      { mtime, level: 9, os: 3, attrs: 0o100644 << 16 },
    ];
  }
  return zipSync(entries, { mtime, level: 9 });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const started = Date.now();
  const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const template = JSON.parse(readFileSync(path.join(appDir, 'manifest.template.json'), 'utf8'));
  const manifest = createManifest(template, { version: pkg.version });
  const extensionId = extensionIdFromPublicKey(manifest.key);

  const dist = path.join(appDir, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(path.join(dist, 'icons'), { recursive: true });
  mkdirSync(path.join(dist, 'fonts'), { recursive: true });

  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    absWorkingDir: appDir,
    entryPoints: { newtab: 'src/newtab/main.ts', options: 'src/options/main.ts' },
    outdir: dist,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome116'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    chunkNames: 'chunks/[name]-[hash]',
    metafile: true,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [contractsPlugin()],
  });
  const cssResult = await esbuild.build({
    absWorkingDir: appDir,
    entryPoints: { newtab: 'src/styles/newtab.css', options: 'src/styles/options.css' },
    outdir: dist,
    bundle: true,
    minify: true,
    target: ['chrome116'],
    external: ['/fonts/*'],
    metafile: true,
    logLevel: 'warning',
  });

  const tokens = resolveTokensCss();
  writeFileSync(path.join(dist, 'tokens.css'), tokens.text);
  for (const page of ['newtab.html', 'options.html'])
    copyFileSync(path.join(appDir, 'public', page), path.join(dist, page));
  const iconSources = new Set();
  for (const [name, target] of [
    ...ICON_SIZES.map((size) => [`icon-${size}.png`, `icon-${size}.png`]),
    ['logo-mark.svg', 'mark.svg'],
  ]) {
    const asset = resolveAsset(name);
    iconSources.add(asset.source);
    copyFileSync(asset.file, path.join(dist, 'icons', target));
  }
  const interDir = path.join(repoRoot, 'node_modules/@fontsource-variable/inter');
  copyFileSync(
    path.join(interDir, 'files/inter-latin-wght-normal.woff2'),
    path.join(dist, 'fonts', 'inter-latin-wght-normal.woff2'),
  );
  writeFileSync(
    path.join(dist, 'THIRD_PARTY_NOTICES.txt'),
    THIRD_PARTY_NOTICES(
      readFileSync(path.join(repoRoot, 'node_modules/zod/LICENSE'), 'utf8'),
      readFileSync(path.join(interDir, 'LICENSE'), 'utf8'),
    ),
  );
  writeFileSync(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Output policy gate.
  const failures = [];
  let zodConfigured = false;
  for (const file of walk(dist)) {
    const rel = path.relative(dist, file);
    const ext = path.extname(file);
    if (ext === '.js') {
      const text = readFileSync(file, 'utf8');
      if (text.includes('__zod_globalConfig')) zodConfigured = true;
      for (const f of scanJs(text)) failures.push(`${rel}: ${f}`);
    } else if (ext === '.html') {
      for (const f of scanHtml(readFileSync(file, 'utf8'))) failures.push(`${rel}: ${f}`);
    } else if (ext === '.css') {
      for (const f of scanCss(readFileSync(file, 'utf8'))) failures.push(`${rel}: ${f}`);
    } else if (ext === '.svg') {
      for (const f of scanSvg(readFileSync(file, 'utf8'))) failures.push(`${rel}: ${f}`);
    } else if (!['.png', '.woff2', '.json', '.txt'].includes(ext)) {
      failures.push(`${rel}: unexpected file type`);
    }
  }
  if (!zodConfigured) failures.push('bundle: zod global config hook not found (jitless mode cannot be enforced)');
  const manifestProblems = checkManifest(JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8')));
  failures.push(...manifestProblems.map((p) => `manifest.json: ${p}`));
  if (failures.length) {
    console.error(`build: output policy check failed:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }

  const idFile = path.join(appDir, 'EXTENSION_ID.txt');
  if (!existsSync(idFile) || readFileSync(idFile, 'utf8').trim() !== extensionId)
    writeFileSync(idFile, `${extensionId}\n`);

  const sizes = Object.entries({ ...result.metafile.outputs, ...cssResult.metafile.outputs })
    .map(([file, info]) => `${path.relative(appDir, path.resolve(appDir, file))} ${(info.bytes / 1024).toFixed(1)} KiB`)
    .sort();
  console.log(
    `build: FinancialOS New Tab ${manifest.version} -> ${path.relative(repoRoot, dist)}/ in ${Date.now() - started} ms`,
  );
  for (const line of sizes) console.log(`  ${line}`);
  console.log(`build: tokens from ${tokens.source}; icons from ${[...iconSources].join(', ')}`);
  console.log(`build: extension ID ${extensionId}`);

  if (args.has('--zip')) {
    const releaseDir = path.join(appDir, 'release');
    mkdirSync(releaseDir, { recursive: true });
    const zipName = `financialos-newtab-${manifest.version}.zip`;
    const zip = await createDeterministicZip(dist);
    writeFileSync(path.join(releaseDir, zipName), zip);
    const sha = createHash('sha256').update(zip).digest('hex');
    writeFileSync(path.join(releaseDir, `${zipName}.sha256`), `${sha}  ${zipName}\n`);
    const size = statSync(path.join(releaseDir, zipName)).size;
    console.log(
      `package: ${path.relative(repoRoot, path.join(releaseDir, zipName))} (${(size / 1024).toFixed(1)} KiB) sha256 ${sha}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
