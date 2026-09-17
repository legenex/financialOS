# Decision log

Reversible engineering decisions, newest last. Each entry states the reason so it can be revisited.

## D-001 Vite SPA + Fastify instead of Next.js

A React single-page app served by a Fastify API server.

* The ten-minute absolute session rule must be enforced on every request, stream, and download. A single Fastify
  `onRequest` hook plus explicit per-handler re-checks is easier to audit than middleware, server components, and
  server actions.
* The HTML shell contains no financial data, so the service worker can cache it safely. Financial data only
  travels as `no-store` API responses that the client clears on lock. Server-rendered HTML would itself be
  sensitive and would need extra cache and back/forward-cache handling.
* One small Node process serves the API and static assets. This fits the ~2 GiB footprint target on a shared
  inference host.

## D-002 npm workspaces with TypeScript source exports

This avoids a global package-manager install and per-package build steps. esbuild bundles the API and worker for
production; Vite bundles the web app.

## D-003 TypeScript 6.0

TypeScript 7 (the native port) is newer, but typescript-eslint 8.70 supports only `<6.1`. Revisit once the lint
toolchain supports 7.x.

## D-004 Node.js 22 LTS in containers and on the host

The host toolchain is Node 22, and all pinned dependencies support it. Containers use `node:22-bookworm-slim`
(glibc, multi-arch with native ARM64). Upgrade to Node 24 as a single tested release.

## D-005 PostgreSQL 17 and pg-boss

PostgreSQL 17 is multi-arch and long-supported. pg-boss provides a durable queue with retries, backoff,
singleton/dedupe keys, cron schedules, and dead-letter queues without extra infrastructure.

## D-006 Drizzle ORM with committed SQL migrations

The schema is typed in TypeScript, and generated SQL migrations are reviewed and committed. The runtime applies them
with a dedicated migration role under an advisory lock. Numeric columns map to strings, so money never passes
through floating point.

## D-007 Session layer on maintained primitives

WebAuthn uses `@simplewebauthn/server`. TOTP uses `otplib` v13 (audited `@noble/hashes`). Password hashing uses
Argon2id via `@node-rs/argon2`. Session tokens are 256-bit random values stored as SHA-256 hashes, following the
OWASP Session Management Cheat Sheet. No cryptographic primitive is implemented in this project.

Full auth frameworks were not used because their sliding-session and sign-up defaults work against a
single-owner, absolute ten-minute design.

## D-008 Password + TOTP as the portable factor, passkeys as the phishing-resistant factor

WebAuthn credentials are bound to the relying-party ID (the hostname). A password with mandatory TOTP and
single-use recovery codes survives origin migration. Passkeys are enrolled per origin and can be re-enrolled after
a domain change.

## D-009 Documents and secrets use AES-256-GCM with a versioned keyring

Keys live in files outside the database and the repository and are mounted read-only into the containers.
Ciphertext records the key version, so keys can be rotated without re-encrypting everything at once.

## D-010 Separate databases for test and demo data

Synthetic data exists only in the `financialos-test` and `financialos-dev` Compose projects. The production database
never contains synthetic records. "Demo workspace" means the separate dev environment.

## D-011 Open-source finance projects (timeboxed evaluation)

These were evaluated for reuse: Firefly III (AGPL, PHP, its own ledger), Actual Budget (MIT, local-first budget model),
Maybe Finance (AGPL, archived by its maintainers in 2025), GnuCash/Beancount/hledger (plain-text or desktop ledgers),
and Ghostfolio (AGPL, portfolio only).

None was adopted as a component. Each brings its own ledger and ownership model that does not separate legal entity
from economic owner or handle third-party clearing. Several are AGPL, and stitching them together would create
several systems of record. The per-currency-balanced journal follows the plain-text-accounting convention
(Beancount/hledger), and OFX parsing follows the published OFX 1.x/2.x specifications. No code was copied.
