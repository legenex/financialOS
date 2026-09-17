#!/usr/bin/env node
// Project-specific sensitive-data gate.
//
// Credential scanners do not catch private financial amounts, names, or network
// inventory. This check combines:
//   1. a private denylist that lives OUTSIDE the repository (the denylist itself
//      is sensitive), loaded from $FOS_PRIVACY_DENYLIST or the default runtime path;
//   2. generic built-in patterns (wallet addresses, IBANs, card numbers, private
//      keys, tailnet addresses, personal email addresses, bearer tokens);
//   3. file-type rules (database dumps, backups, real statements, screenshots
//      outside approved asset folders).
//
// Usage:
//   node scripts/privacy/privacy-check.mjs --staged      # staged blobs (pre-commit)
//   node scripts/privacy/privacy-check.mjs --all         # tracked + untracked, not ignored
//   node scripts/privacy/privacy-check.mjs --dir <path>  # arbitrary artifact directory
//   node scripts/privacy/privacy-check.mjs --range A..B  # files changed in a commit range (pre-push)
//
// Exit code 1 when any finding is reported. Findings print file:line and the rule,
// never the matched private term.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const DEFAULT_DENYLIST = '/srv/projects/financialos/config/privacy-denylist.txt';
const denylistPath = process.env.FOS_PRIVACY_DENYLIST || DEFAULT_DENYLIST;
const allowlist = JSON.parse(readFileSync(path.join(ROOT, 'scripts/privacy/allowlist.json'), 'utf8'));

const args = process.argv.slice(2);
const mode = args[0] ?? '--staged';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const BLOCKED_EXTENSIONS = new Set([
  '.dump', '.backup', '.bak', '.sqlite', '.sqlite3', '.db', '.har', '.enc', '.age', '.gpg',
  '.p12', '.pfx', '.pem', '.key', '.kdbx', '.env',
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.xlsx', '.xls', '.zip', '.woff', '.woff2', '.ttf',
]);
// Binary assets are only permitted in these folders (packaged icons, fonts, synthetic fixtures).
const BINARY_ALLOWED_PREFIXES = allowlist.binaryAllowedPrefixes;

function loadDenylist() {
  if (!existsSync(denylistPath)) {
    if (process.env.CI) return { terms: [], regexes: [], missing: true };
    console.error(`privacy-check: private denylist not found at ${denylistPath}.`);
    console.error('Refusing to pass without it on a developer machine. Set FOS_PRIVACY_DENYLIST.');
    process.exit(2);
  }
  const terms = [];
  const regexes = [];
  for (const raw of readFileSync(denylistPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('re:')) regexes.push(new RegExp(line.slice(3), 'i'));
    else terms.push(line.toLowerCase());
  }
  return { terms, regexes, missing: false };
}

const GENERIC_RULES = [
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/ },
  { id: 'tailnet-hostname', re: /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i },
  { id: 'tailnet-ipv4', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  { id: 'eth-address', re: /\b0x[a-fA-F0-9]{40}\b/g, allow: (m) => allowlist.ethAddresses.includes(m.toLowerCase()) },
  { id: 'btc-bech32-address', re: /\b(?:bc1|tb1)[ac-hj-np-z02-9]{25,87}\b/g, allow: (m) => allowlist.btcAddresses.includes(m.toLowerCase()) },
  { id: 'btc-base58-address', re: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, allow: (m) => allowlist.btcAddresses.includes(m.toLowerCase()) || !/\d/.test(m) || !/[A-Z]/.test(m) || !/[a-z]/.test(m) },
  { id: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, allow: (m) => !ibanValid(m) },
  { id: 'payment-card-number', re: /\b(?:\d[ -]?){13,19}\b/g, allow: (m) => !luhnCardLike(m) },
  { id: 'email-address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, allow: (m) => allowedEmail(m) },
  { id: 'bearer-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/ },
  { id: 'mercury-token', re: /secret-token:mercury_production_[A-Za-z0-9_]+/i },
];

function allowedEmail(m) {
  const lower = m.toLowerCase();
  const domain = lower.split('@')[1] ?? '';
  if (allowlist.emailDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  if (lower.endsWith('@users.noreply.github.com')) return true;
  // package-style identifiers such as foo@1.2.3 are not email addresses
  return /^\d/.test(domain);
}

function luhnCardLike(m) {
  const digits = m.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  if (!/^[3-6]/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0 && !allowlist.cardNumbers.includes(digits);
}

function ibanValid(m) {
  const s = m.replace(/ /g, '');
  if (s.length < 15 || s.length > 34) return false;
  if (allowlist.ibans.includes(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function listFiles() {
  if (mode === '--staged') {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean).map((f) => ({ file: f, read: () => execFileSync('git', ['show', `:${f}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }) }));
  }
  if (mode === '--range') {
    const range = args[1];
    const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', '-z', range], { cwd: ROOT, encoding: 'utf8' });
    const head = range.split('..')[1] || 'HEAD';
    return out.split('\0').filter(Boolean).map((f) => ({ file: f, read: () => execFileSync('git', ['show', `${head}:${f}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }) }));
  }
  if (mode === '--all') {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean).filter((f) => existsSync(path.join(ROOT, f))).map((f) => ({ file: f, read: () => readFileSync(path.join(ROOT, f)) }));
  }
  if (mode === '--dir') {
    const dir = path.resolve(args[1]);
    const files = [];
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile()) files.push({ file: p, read: () => readFileSync(p), external: true });
      }
    };
    walk(dir);
    return files;
  }
  console.error(`privacy-check: unknown mode ${mode}`);
  process.exit(2);
}

const deny = loadDenylist();
const findings = [];
const add = (file, line, rule) => findings.push({ file, line, rule });

for (const entry of listFiles()) {
  const { file } = entry;
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  if (allowlist.skipFiles.includes(file)) continue;
  if (BLOCKED_EXTENSIONS.has(ext) || base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) {
    add(file, 0, `blocked-file-type(${ext || base})`);
    continue;
  }
  const buf = entry.read();
  const isBinary = BINARY_EXTENSIONS.has(ext) || buf.subarray(0, 8000).includes(0);
  if (isBinary) {
    if (!entry.external && !BINARY_ALLOWED_PREFIXES.some((p) => file.startsWith(p))) {
      add(file, 0, 'binary-outside-approved-asset-folders');
    }
    // zip packages are inspected separately after extraction (--dir)
    continue;
  }
  if (buf.length > MAX_TEXT_BYTES) {
    add(file, 0, 'oversized-text-file');
    continue;
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  lines.forEach((lineText, idx) => {
    const lower = lineText.toLowerCase();
    for (const term of deny.terms) {
      if (lower.includes(term)) add(file, idx + 1, 'private-denylist-term');
    }
    for (const re of deny.regexes) {
      if (re.test(lineText)) add(file, idx + 1, 'private-denylist-pattern');
    }
    if (lineText.includes('privacy-check: allow-generic')) return;
    for (const rule of GENERIC_RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
      for (const match of lineText.matchAll(re)) {
        if (rule.allow && rule.allow(match[0])) continue;
        add(file, idx + 1, rule.id);
      }
    }
  });
}

if (deny.missing) console.warn('privacy-check: running in CI without the private denylist (generic rules only).');

if (findings.length) {
  console.error(`privacy-check: ${findings.length} finding(s). Matched values are intentionally not printed.`);
  for (const f of findings.slice(0, 200)) console.error(`  ${f.file}:${f.line}  ${f.rule}`);
  process.exit(1);
}
console.log(`privacy-check: clean (${mode}).`);
