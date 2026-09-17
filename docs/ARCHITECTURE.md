# FinancialOS architecture

FinancialOS is a self-hosted, single-owner financial command centre for personal and
business finances. The PostgreSQL database and the deterministic financial engine are
the system of record. AI and MCP are optional interfaces and never the authority for
arithmetic, ownership, or policy.

This document is the working contract between the modules. Architectural decisions and
their reasons are recorded in [DECISIONS.md](DECISIONS.md).

## Runtime topology

```
browser (SPA) ──HTTPS──▶ private HTTPS route (e.g. Tailscale Serve) ──▶ 127.0.0.1:<port>
                                                                            │
                                                         ┌──────────────────▼─────────────────┐
                                                         │ app container (Fastify)            │
                                                         │  • serves the built SPA shell      │
                                                         │  • /api/*   owner API (session)    │
                                                         │  • /api/ext/* extension glance     │
                                                         │  • /api/agent/*, /mcp  agent API   │
                                                         └──────┬───────────────┬─────────────┘
                                                                │ internal net  │ egress (SSRF-guarded)
                                  ┌─────────────────────┐       │               │
                                  │ worker container     │◀─────┤               ▼
                                  │ pg-boss jobs, syncs, │      │        provider APIs
                                  │ imports, backups     │──────┘
                                  └──────────┬──────────┘
                                             │ internal network only
                                       ┌─────▼─────┐
                                       │ PostgreSQL │  (not published to the host)
                                       └───────────┘
```

* One Docker Compose project per environment (`financialos` for production,
  `financialos-test` for automated tests, `financialos-dev` for synthetic demo data).
  No fixed container names, no Docker socket, no privileged containers.
* The app port is bound to loopback only. HTTPS is terminated by the private route
  in front of it. The database is reachable only on an internal Docker network.
* Background work runs in the worker with its own database role. Web logout or
  session expiry never cancels an authorised job.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/web` | React single-page app (Vite). Contains no financial data at build time. |
| `apps/api` | Fastify server: owner API, auth, extension endpoints, agent API + read-only MCP, static SPA. |
| `apps/worker` | Durable job runner (pg-boss): imports, syncs, schedules, forecasts, alerts, backups. |
| `apps/extension` | Chrome Manifest V3 New Tab extension, packaged separately. |
| `packages/contracts` | Zod schemas and types shared across the HTTP boundary. |
| `packages/domain` | Pure, deterministic financial engine (no I/O). |
| `packages/db` | Drizzle schema, SQL migrations, repositories, bootstrap loader. |
| `packages/integrations` | File parsers, provider adapters, capability declarations, MCP client. |
| `packages/security` | AEAD keyring, token hashing, SSRF-safe fetch, redaction, CSV export safety. |
| `packages/ui` | Design tokens, icon/identity assets, shared React components. |
| `tests/` | Cross-package integration tests, Playwright end-to-end tests, synthetic fixtures. |
| `deploy/` | Dockerfiles, Compose files, operational scripts (deploy, backup, restore, rollback). |
| `docs/` | Generic documentation. Private operational notes never live here. |

Workspace packages export TypeScript source (`"exports": "./src/index.ts"`). The web
app is bundled by Vite; the API and worker are bundled by esbuild into single ESM files
for production. Relative imports omit extensions (`moduleResolution: Bundler`).

## Money and numbers

* Authoritative amounts are `Decimal` (decimal.js) in code, `numeric(38,18)` in
  PostgreSQL, and **strings** across JSON boundaries (`"1234.50"`). Binary floating
  point is never used for money or quantities (`parseFloat` is lint-banned).
* `Money = { amount: string; currency: string }`. Fiat amounts are validated against the
  currency's minor units (ZAR/USD/GBP/AED/EUR: 2, JPY: 0, BTC: 8, ETH: 18).
* Converted values always carry `{ rate, rateSource, rateAsOf, method }` provenance.
  Historical reports use the rate as of the transaction date (`method: "historical"`);
  balance-sheet views use the rate as of the valuation date (`method: "spot_at_valuation"`).
  A missing rate yields an explicit `unconverted` entry, never a silent zero.
* Unknown is not zero: nullable amounts propagate as `null` and push results to
  `provisional` or `insufficient_data`.
* Dates: effective/booking dates are ISO calendar dates (`YYYY-MM-DD`) interpreted in the
  source's time zone and preserved with `sourceTimezone`. Instants are UTC ISO strings.
  The reporting time zone is a setting (default `Africa/Johannesburg`). The server time
  zone is never changed.

## Data model (summary)

Separate concepts are separate columns/tables: **legal entity**, **economic owner**,
**institution**, **account**, **currency**, **instrument**, **counterparty**,
**category**, **tag**, **restriction**, **provenance**.

* `entities` — person, company, trust, third party. `owner_controlled`, `primary_owner`.
* `ownership_interests` — holder → held entity with an optional, confirmable percentage.
* `institutions`, `counterparties`, `instruments`, `currencies`, `fx_rates`, `prices`.
* `accounts` — `legal_entity_id` (nullable = unconfirmed), `economic_owner_entity_id`
  (nullable), `kind`, `currency` (nullable for multi-currency), `liquidity_class`
  (`cash | near_cash | marketable | restricted | illiquid | property | liability |
  receivable | contingent`), `include_in_safe_to_spend`, provenance.
* `account_ownership_rules` — card-level / pattern rules that assign economic owner.
* **Ledger:** `ledger_accounts` (per entity chart), `journal_entries` (immutable once
  posted; corrections are reversals plus new entries), `journal_lines` (signed amount,
  debit positive; every entry balances **per currency**; cross-currency movements use a
  per-currency FX clearing account — the trading-account method).
* `source_records` — immutable raw rows from imports and APIs with dedupe keys, pending /
  posted state, upstream versioning.
* `classifications` — versioned, one current version per source record, with `nature`
  (consumption, transfer_internal, salary, intercompany, third_party, investment_*,
  property_purchase, business_support, fee, interest, refund, tax, unknown …), splits,
  confidence, and method (`rule | user | model | provider | transfer_match`).
* `transfer_matches` — explainable candidate matches with confidence and status.
* `balance_snapshots` — `reported_at` and `source_as_of` (nullable) kept separate;
  `kind` (`owner_reported_total`, `statement_closing`, `provider_current`,
  `provider_available`, `opening`). A snapshot is never income.
* `holdings_snapshots` / `holding_lines`, `investment_transactions`, `corporate_actions`.
* `restrictions`, `watch_events`, `fixed_income_terms`, `liability_terms`, `property_details`.
* `third_party_arrangements` — fee rate, fee mode (`deducted_from_receipt |
  charged_on_top | unconfirmed`), recipient, clearing accounts, opening balance.
* `documents` (encrypted blobs), `import_batches`, `import_rows`, `import_templates`,
  `coverage_periods`, `reconciliations`.
* `exceptions` — the single exception inbox (dedupe key, subject, severity, resolution).
* `connections`, `connection_secrets` (ciphertext only), `connection_accounts`,
  `oauth_clients`, `oauth_states`, `oauth_tokens`, `outbound_allowlist`, `sync_runs`.
* `job_records` — user-visible job state mirrored from pg-boss (progress, cancel flag,
  idempotency key, redacted error).
* Planning: `budgets`, `budget_lines`, `goals`, `goal_contributions`, `recurring_items`,
  `obligations`, `receivables_payables`, `scenarios`.
* Behaviour: `reviews`, `achievements`, `notifications`, `schedules`.
* Investments: `trade_proposals`, `paper_fills`, `risk_policies`, `execution_mandates`
  (execution disabled; no connector exists).
* AI: `ai_providers`, `ai_usage`, `coach_threads`, `coach_messages`.
* Context: `tax_facts`, `reward_products`, `travel_preferences`, `settings`.
* Security: `owner_account`, `setup_state`, `webauthn_credentials`, `recovery_codes`,
  `sessions`, `login_throttle`, `launch_requests`, `devices`, `device_pairings`,
  `agent_clients`, `audit_events` (append-only via grants and triggers; a database
  superuser can still alter it, so it is not described as tamper-proof), `backups`.

## Financial engine rules (packages/domain)

* **Safe-to-spend** uses eligible personal cash only (economic owner = primary owner,
  liquidity `cash`, `include_in_safe_to_spend`), removes third-party attributable
  balances, runs a dated cash-flow projection over an explicit horizon (each obligation
  subtracted exactly once, on its date), takes the minimum projected balance, and then
  subtracts protected reserves that are held inside the eligible accounts. Reserves held
  in excluded accounts are not subtracted again. Output includes inputs, exclusions,
  assumptions, confidence, timeline, and a `status` of `ok | provisional |
  insufficient_data`.
* **Runway** reports `not_depleting` when trailing net cash flow is positive and
  `insufficient_history` below a configured minimum, instead of a misleading number.
* **Consolidation** eliminates movements whose both sides are inside the selected entity
  scope (intercompany invoices, salary to the owner, personal ↔ business transfers) while
  entity reports keep them. Company assets and the owner's equity value in the same
  company are never both counted.
* **Third-party clearing**: receipts, fees (per mode), card spend, transfers,
  reimbursements, settlements → amount owed. `unconfirmed` fee mode recognises no fee
  income and raises an exception.
* **Valuation precedence** per account: verified complete holdings > provider balance >
  statement closing > owner-reported total. Sources are never summed.
* **Restricted assets** are excluded from spending capacity and runway. Sale schedules
  require verified restriction terms and actual or explicitly hypothetical volume.
  Price × shares is labelled indicative, not proceeds.
* **Fixed income** distinguishes nominal vs effective rates and compounding; accrued
  interest is not spendable.

## HTTP API conventions (apps/api)

* All owner endpoints live under `/api/` and require a valid session, except the
  explicitly public auth/setup endpoints.
* Request and response bodies are validated with `@financialos/contracts` schemas.
* Every response under `/api/` sends `Cache-Control: no-store`, `Pragma: no-cache`.
* Mutations require: valid session, exact `Origin` match with the canonical origin
  list, and `X-CSRF-Token` equal to the session's CSRF token. Cookies are
  `SameSite=Strict`, `HttpOnly`, `Secure`, host-only, `__Host-` prefixed.
* Errors: `{ error: { code, message, details? } }`; `401 session_expired` when the
  session is invalid, expired, or revoked.
* Background requests (polling) send `X-FOS-Background: 1` and never count as activity.
* Long-running work is enqueued as a job; the response returns a `jobId`.
  Server-sent event streams close at session expiry and re-check the session before
  every event.

## Session rules

* Absolute lifetime: 600 s from authentication. Never extended by activity, polling,
  token rotation, or extension requests. Idle timeout: configurable, at most 600 s.
* Enforcement is server-side on every private request; the server re-checks the session
  immediately before delivering results from long operations.
* A new authentication creates a new session and revokes the old one.
* Extension device credentials and agent credentials are separate, cannot mint web
  sessions, and are accepted only on their dedicated endpoints.

## Extension contract

* Pairing: `POST /api/ext/pair/start` (installation-bound, returns a short user code),
  owner approves in an authenticated session, `POST /api/ext/pair/complete` presents the
  installation verifier and receives an expiring device credential (stored hashed).
* Glance: `GET /api/ext/v1/glance` with `Authorization: Bearer <device credential>` and
  an `Origin` matching the paired extension id. Returns only the fields the device is
  permitted to see; masked by default.
* Launch: `GET /launch/<target>` creates a short-lived launch request and redirects to a
  login screen that requires fresh authentication before returning the allowlisted
  destination.

## Agent API and MCP

* `/api/agent/v1/*` and `/mcp` accept agent credentials only (never session cookies).
  Tools are read-only or produce drafts/suggestions. Scopes and entity scopes are
  enforced server-side; every call is audited.

## Jobs

pg-boss queues (names are stable): `import.parse`, `import.commit`, `import.reverse`,
`sync.connection`, `sync.backfill`, `fx.refresh`, `prices.refresh`, `recurring.detect`,
`alerts.evaluate`, `review.prepare`, `reconcile.monthly`, `backup.run`,
`backup.verify`, `ai.task`, `maintenance.retention`. Every job has an idempotency key,
retry with backoff, a dead-letter queue, progress in `job_records`, and cooperative
cancellation where safe. Ledger writes are idempotent (unique source keys), so a retried
or resumed job never duplicates ledger effects.
