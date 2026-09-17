# HTTP API

All request/response bodies are defined in `packages/contracts`. Unless marked **public**, endpoints require a
valid owner session. All `/api/*` responses are `Cache-Control: no-store`. Mutations (`POST`, `PUT`, `PATCH`,
`DELETE`) also require an exact `Origin` match and an `X-CSRF-Token` header.

Query parameters common to finance views: `entityId` (optional), `scope` (`personal | consolidated | entity`),
`from` / `to` (ISO dates), `currency` (reporting currency override), `scenarioId`.

## Auth and setup

| Method | Path | Body → Response | Notes |
|---|---|---|---|
| GET | `/api/setup/status` | → `SetupStatus` | public |
| POST | `/api/setup/begin` | `SetupBeginInput` → `SetupStatus` | public, throttled, sets setup cookie |
| POST | `/api/setup/owner` | `SetupOwnerInput` → `SetupStatus` | setup cookie |
| POST | `/api/setup/totp/start` | → `TotpEnrollment` | setup cookie |
| POST | `/api/setup/totp/verify` | `TotpVerifyInput` → `SetupStatus` | setup cookie |
| POST | `/api/setup/recovery-codes` | → `RecoveryCodes` | setup cookie, shown once |
| POST | `/api/setup/passkey/options` | → WebAuthn creation options | setup cookie |
| POST | `/api/setup/passkey/verify` | registration response → `SetupStatus` | setup cookie |
| POST | `/api/setup/seal` | → `SetupStatus` | setup cookie; afterwards all setup endpoints return 410 |
| POST | `/api/auth/login/password` | `PasswordLoginInput` → `LoginResult` | public, throttled |
| POST | `/api/auth/passkey/options` | → WebAuthn request options | public, throttled |
| POST | `/api/auth/passkey/verify` | `PasskeyLoginFinishInput` → `LoginResult` | public, throttled |
| GET | `/api/auth/session` | → `SessionInfo` | never counts as activity |
| GET | `/api/auth/launch` | → `LaunchInfo` | public; requires launch cookie |
| POST | `/api/auth/logout` | → 204 | |
| POST | `/api/auth/logout-all` | → 204 | revokes every session |
| GET | `/launch/:target` | → 303 `/login?launch=1` | public server route; creates launch request |

## Security settings

| GET | `/api/security` | → `SecurityOverview` |
|---|---|---|
| POST | `/api/security/passkeys/options` / `/api/security/passkeys/verify` | add passkey |
| DELETE | `/api/security/passkeys/:id` | remove passkey (another factor must remain) |
| POST | `/api/security/recovery-codes` | `{ totpCode }` → `RecoveryCodes` |
| POST | `/api/security/password` | `PasswordChangeInput` → 204 |
| DELETE | `/api/security/sessions/:id` | revoke session |
| PUT | `/api/security/idle-timeout` | `{ seconds }` (60–600) |

## Today, search, inbox, notifications

| GET | `/api/today` | → `TodayResponse` |
|---|---|---|
| GET | `/api/safe-to-spend` | → `SafeToSpendResult` (`horizonDays`, `scenarioId`) |
| GET | `/api/runway` | → `RunwayResult[]` (personal + each business) |
| GET | `/api/wealth` | → `WealthSummary` (`scope`, `entityId`) |
| GET | `/api/search?q=` | → `SearchResult` |
| GET | `/api/exceptions?status=&kind=` | → `{ items: ExceptionItem[] }` |
| POST | `/api/exceptions/:id` | `ExceptionResolveInput` → `ExceptionItem` |
| GET | `/api/notifications` | → `{ items: Notification[], unread }` |
| POST | `/api/notifications/:id/read` · `/api/notifications/read-all` | |

## Money

| GET | `/api/entities` · POST `/api/entities` · PATCH `/api/entities/:id` | `Entity` / `EntityInput` |
|---|---|---|
| GET | `/api/institutions` · POST `/api/institutions` | `Institution` |
| GET | `/api/accounts` · POST `/api/accounts` | `Account[]` / `AccountInput` |
| GET · PATCH | `/api/accounts/:id` | `Account` / `AccountInput` (partial) |
| GET · POST | `/api/accounts/:id/snapshots` | `BalanceSnapshot[]` / `BalanceSnapshotInput` |
| GET | `/api/accounts/:id/holdings` | → `Holdings` |
| GET | `/api/accounts/:id/reconciliations` | → `Reconciliation[]` |
| GET | `/api/accounts/:id/coverage` | → `{ gaps: CoverageGap[], periods }` |
| GET | `/api/transactions` | `TransactionQuery` → `TransactionPage` |
| GET | `/api/transactions/:id` | → `Transaction` + history |
| POST | `/api/transactions/:id/classify` | `ClassificationInput` → `Transaction` |
| POST | `/api/transfer-matches/:id` | `{ action: confirm \| reject }` |
| GET | `/api/transactions/export.csv` | formula-injection-safe CSV (audited) |
| GET | `/api/categories` · POST `/api/categories` | `Category` |
| GET · POST · PATCH | `/api/rules` | classification rules |
| GET | `/api/portfolio` | → `PortfolioSummary` |
| GET · POST · PATCH | `/api/restrictions` | `Restriction` |
| POST | `/api/restricted/sale-schedule` | `SaleScheduleRequest` → `SaleScheduleResult` |
| GET · PUT | `/api/accounts/:id/fixed-income` | `FixedIncomeTerms` |
| GET | `/api/accounts/:id/interest-projection` | → `InterestProjection` |
| GET · POST | `/api/documents` | `DocumentRecord` (multipart upload) |
| GET | `/api/documents/:id/download` | session re-checked before streaming |
| GET · POST · PATCH | `/api/watch-events` | unverified events (listings, releases) |

## Imports

| POST | `/api/imports` | multipart file → `ImportBatch` (file checks run immediately) |
|---|---|---|
| GET | `/api/imports` · `/api/imports/:id` | `ImportBatch` |
| POST | `/api/imports/:id/configure` | `ImportConfigureInput` → `ImportBatch` (enqueues parse) |
| GET | `/api/imports/:id/preview?status=&cursor=` | → `{ items: PreviewRow[], nextCursor }` |
| POST | `/api/imports/:id/commit` | `ImportCommitInput` → `{ jobId }` |
| POST | `/api/imports/:id/reverse` | `ImportReverseInput` → `{ jobId }` |
| POST | `/api/imports/:id/cancel` | → `ImportBatch` |
| GET · POST · DELETE | `/api/import-templates` | `ImportTemplate` |

## Plan

| GET | `/api/budgets?period=` · POST `/api/budgets` · PUT `/api/budgets/:id` | `Budget` / `BudgetInput` |
|---|---|---|
| GET · POST · PUT · DELETE | `/api/goals` | `Goal` / `GoalInput` |
| GET · POST | `/api/goals/:id/contributions` | `GoalContribution` / `GoalContributionInput` |
| GET · POST · PUT | `/api/recurring` | `RecurringItem` / `RecurringItemInput` (`?status=suggested` for detections) |
| POST | `/api/recurring/:id/confirm` · `/dismiss` | detected items |
| GET · POST · PUT | `/api/obligations` | `Obligation` / `ObligationInput` |
| POST | `/api/plan/purchase-impact` | `PurchaseImpactInput` → `PurchaseImpactResult` |
| GET · POST · PUT · DELETE | `/api/scenarios` | `Scenario` / `ScenarioInput` (versioned; delete archives) |
| GET · POST · PUT | `/api/rewards/products` | `RewardProduct` |
| POST | `/api/rewards/compare` | `RewardComparisonInput` → `RewardComparisonResult` |
| GET · PUT | `/api/tax-facts` | `TaxFact` / `TaxFactInput` |

## Business

| GET | `/api/business/entities` | → `EntityCashSummary[]` (`from`, `to`) |
|---|---|---|
| GET | `/api/business/consolidated` | → `ConsolidatedView` (`entityIds`) |
| GET | `/api/business/forecast?entityId=&scenarioId=` | → `CashForecast` (13 weeks) |
| GET · POST · PUT | `/api/business/receivables-payables` | `ReceivablePayable` / `ReceivablePayableInput` |
| GET | `/api/business/clearing` | → `ClearingAccountSummary[]` |
| PUT | `/api/business/clearing/:arrangementId/policy` | `ArrangementPolicyInput` |
| GET | `/api/business/support` | → `SupportTracker` |

## Coach and investing

| GET | `/api/coach/threads` · `/api/coach/threads/:id` | `CoachMessage[]` |
|---|---|---|
| POST | `/api/coach/ask` | `CoachAskInput` → `{ threadId, messageId }` |
| GET | `/api/coach/stream/:messageId` | SSE; closes at session expiry |
| POST | `/api/coach/messages/:id/cancel` | |
| GET | `/api/reviews` · POST `/api/reviews` `{ kind }` | `Review` |
| PATCH | `/api/reviews/:id` | checklist, notes, complete |
| GET | `/api/achievements` | `Achievement[]` |
| GET · POST | `/api/trade-proposals` | `TradeProposal` (paper only) |
| GET · PUT | `/api/risk-policy` | `RiskPolicy` |
| GET | `/api/execution-status` | `ExecutionStatus` (always disabled) |

## Connections

| GET | `/api/providers` | → `ProviderDescriptor[]` |
|---|---|---|
| GET · POST | `/api/connections` | `Connection` / `ConnectionCreateInput` |
| GET · PATCH · DELETE | `/api/connections/:id` | `ConnectionUpdateInput`; delete revokes and removes secrets |
| PUT | `/api/connections/:id/credentials` | `CredentialInput` → `Connection` (write-only) |
| DELETE | `/api/connections/:id/credentials` | revoke stored credential |
| POST | `/api/connections/:id/test` | → `{ jobId }` |
| POST | `/api/connections/:id/discover-accounts` | → `{ jobId }` |
| PUT | `/api/connections/:id/accounts` | `AccountMappingInput` |
| POST | `/api/connections/:id/sync` | → `{ jobId }` |
| POST | `/api/connections/:id/backfill` | `BackfillInput` → `{ jobId }` |
| POST | `/api/connections/:id/oauth/start` | → `OAuthStartResult` |
| GET | `/api/oauth/callback` | provider redirect target (validates state, PKCE) |
| GET · POST · DELETE | `/api/outbound-allowlist` | `OutboundAllowlistEntry` |
| GET · POST · PUT | `/api/ai-providers` | `AiProvider` / `AiProviderInput` |
| PUT | `/api/ai-providers/:id/credentials` | `CredentialInput` |
| POST | `/api/ai-providers/:id/test` | → `{ ok, detail }` |
| GET · POST | `/api/agent-clients` | `AgentClient` / `AgentClientInput` → `AgentClientCreated` |
| POST | `/api/agent-clients/:id/revoke` | |

## Jobs, settings, system

| GET | `/api/jobs?status=` · `/api/jobs/:id` | `JobRecord` |
|---|---|---|
| POST | `/api/jobs/:id/cancel` | cooperative cancellation |
| GET | `/api/jobs/:id/events` | SSE progress; closes at session expiry |
| GET · PUT | `/api/settings` | `AppSettings` |
| GET · PUT | `/api/schedules` · `/api/schedules/:id` | `Schedule` / `ScheduleUpdateInput` |
| GET | `/api/system` | `SystemStatus` |
| POST | `/api/system/domain-migration/plan` | `DomainMigrationInput` → `DomainMigrationPlan` |
| GET · POST | `/api/backups` | `BackupRecord[]` / start backup `{ jobId }` |
| POST | `/api/backups/:id/verify` | isolated restore verification `{ jobId }` |
| GET | `/api/audit?cursor=` | `AuditEvent` page |
| GET | `/api/devices` | `Device[]` |
| POST | `/api/devices/pair/approve` | `PairApproveInput` → `Device` |
| PUT | `/api/devices/:id/privacy` | `DevicePrivacyInput` → `Device` |
| POST | `/api/devices/:id/revoke` · `/api/devices/revoke-all` | |
| GET | `/api/extension/package` | authenticated ZIP download |
| GET | `/healthz` · `/readyz` | public, no financial data |

## Extension (device credential, never session cookies)

| POST | `/api/ext/pair/start` | `PairStartInput` → `PairStartResult` |
|---|---|---|
| POST | `/api/ext/pair/complete` | `PairCompleteInput` → `PairCompleteResult` |
| GET | `/api/ext/v1/glance` | → `GlanceResponse` (Bearer device credential + paired extension Origin) |

## Agents (agent credential, never session cookies)

| GET | `/api/agent/v1/summary` · `/accounts` · `/transactions` · `/budgets` · `/forecast` · `/portfolio` · `/exceptions` | scoped reads |
|---|---|---|
| POST | `/api/agent/v1/simulate/portfolio` · `/draft/review` · `/suggest/classification` | drafts and suggestions only |
| POST | `/mcp` | read-only MCP (Streamable HTTP, stateless) |
