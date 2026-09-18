# Verification matrix

This matrix maps each requirement to the checks that exercise it. The **Status** column records the latest
verified result on the deployment host.

Status values:
* **pass**: the check executed and succeeded.
* **blocked**: an external authorisation is missing. Implementation exists and is contract-tested.
* **gap**: not verified. The reason is stated.

Evidence is summarised here. Raw logs, screenshots, and traces that could contain real data stay in the private
runtime directory.

| # | Requirement | Checks | Status |
|---|---|---|---|
| V1 | Clean install, lint, format, typecheck, production builds | `npm ci`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build` | pending |
| V2 | ARM64 runtime | Image architecture inspection; containers healthy on the arm64 host | pending |
| V3 | Exact arithmetic and ledger invariants | `packages/domain` unit tests; database balance trigger integration tests | pending |
| V4 | Cross-currency transfers, fee modes, third-party exclusions | domain-core tests (ledger, thirdParty, wealth) | pending |
| V5 | Intercompany elimination; snapshot/holdings de-duplication; restricted-asset exclusion | domain-core tests (consolidation, valuation); domain-planning tests (restricted) | pending |
| V6 | Safe-to-spend scenarios: missing data, no double subtraction, no business cash as personal | domain-planning safeToSpend tests | pending |
| V7 | Parsing: CSV, XLSX, OFX/QFX, PDF, IBKR Flex; date formats; hostile files | integrations parser tests | pending |
| V8 | Duplicate imports, legitimate repeats, reconciliation failures, correction and undo | domain dedupe/reconciliation tests; worker import integration tests | pending |
| V9 | Adapter contracts: pagination, expired tokens, rate limits, retry safety, missing history | integrations contract tests with mock servers | pending |
| V10 | Configured vs live-verified distinction | provider registry `verificationLevel`; Connections UI | pending |
| V11 | Owner bootstrap, password+TOTP, recovery, passkey | api integration tests; e2e with virtual authenticator | pending |
| V12 | Unauthorized reads/writes, CSRF, SSRF, object access, secret redaction | api integration tests; safeFetch tests; redaction tests | pending |
| V13 | 599 s accepted, 600 s rejected despite activity; polling, refresh, sleep, tabs, downloads, streams | api fake-clock tests; e2e real-time 10-minute test; web session tests | pending |
| V14 | Extension pairing, scope, expiry/revocation, masking, fresh-auth launch, offline, manifest | api tests; extension unit and runtime tests; e2e launch test | pending |
| V15 | Extension runtime in a real Chromium profile | Playwright Chromium with the unpacked extension | pending |
| V16 | Core functions with AI offline | e2e with no AI provider configured | pending |
| V17 | Durable jobs survive logout and worker restart without duplicate ledger effects | worker integration tests; e2e restart test | pending |
| V18 | Responsive layouts, keyboard, accessibility, no leaks during loading/logout/back | visual suite (3 viewports × 2 themes), axe, overflow assertions, e2e back-button test | pending |
| V19 | Encrypted backup and isolated restore | `deploy/scripts/restore-verify.sh` | pending |
| V20 | Container restart recovery | restart app/worker containers; health and data checks | pending |
| V21 | Tailscale HTTPS route | `deploy/scripts/tailscale-route.sh verify` | pending |
| V22 | Pre-existing host services and routes intact | `deploy/scripts/host-check.sh compare` | pending |
| V23 | Privacy scans of staged source and artifacts | `privacy-check` (staged, web dist, extension ZIP); gitleaks | pending |
| V24 | Independent financial, security, and UX reviews | review reports and repairs | pending |
