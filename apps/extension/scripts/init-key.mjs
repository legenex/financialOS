#!/usr/bin/env node
/* eslint-disable no-console -- this is an operator CLI whose whole output is console text. */
// One-time setup of the extension key pair that pins the extension ID.
//
// The private key lives OUTSIDE the repository (default: the deployment's private runtime
// directory, override with FOS_EXTENSION_KEY_PATH). It is created with mode 0600 and is never
// overwritten. Only the public key (SPKI DER, base64) is written to manifest.template.json, where
// Chrome uses it to derive a stable extension ID for unpacked installs. The private key is only
// needed if a signed .crx is ever produced; the unpacked build and the ZIP do not use it.
//
// Usage: node scripts/init-key.mjs

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromPublicKey } from '../build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const templatePath = path.join(appDir, 'manifest.template.json');
const keyPath = process.env.FOS_EXTENSION_KEY_PATH ?? '/srv/projects/financialos/secrets/extension-key.pem';

let publicKey;
if (existsSync(keyPath)) {
  const mode = statSync(keyPath).mode & 0o777;
  if (mode & 0o077) {
    console.error(`init-key: ${keyPath} is readable by group/others (mode ${mode.toString(8)}). Fix with chmod 600.`);
    process.exit(1);
  }
  publicKey = createPublicKey(createPrivateKey(readFileSync(keyPath)));
  console.log(`init-key: using the existing private key at ${keyPath}`);
} else {
  mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  // flag 'wx' refuses to overwrite a file that appeared in the meantime.
  writeFileSync(keyPath, pem, { mode: 0o600, flag: 'wx' });
  publicKey = pair.publicKey;
  console.log(`init-key: created a new private key at ${keyPath} (mode 600)`);
}

const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const template = JSON.parse(readFileSync(templatePath, 'utf8'));
if (template.key !== publicKeyBase64) {
  template.key = publicKeyBase64;
  writeFileSync(templatePath, `${JSON.stringify(template, null, 2)}\n`);
  console.log('init-key: updated the public key in manifest.template.json');
}

// The ID is public: Chrome derives it from the public key, and the FinancialOS server must list it
// in allowedExtensionIds before it will answer this extension. The build keeps this file in step.
const extensionId = extensionIdFromPublicKey(publicKeyBase64);
const idPath = path.join(appDir, 'EXTENSION_ID.txt');
if (!existsSync(idPath) || readFileSync(idPath, 'utf8').trim() !== extensionId) {
  writeFileSync(idPath, `${extensionId}\n`);
  console.log(`init-key: wrote ${path.relative(appDir, idPath)}`);
}
console.log(`init-key: extension ID ${extensionId}`);
console.log('init-key: add this ID to the FinancialOS server configuration (allowedExtensionIds).');
