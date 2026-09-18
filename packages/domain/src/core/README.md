# domain-core

The core of the deterministic financial engine: pure TypeScript with no I/O. Everything is exported from
`@financialos/domain` through `src/core/index.ts`.

Conventions used everywhere:

* Money is `{ amount: decimal string, currency }` and the arithmetic uses `Decimal` (`../money`). JS numbers are
  used only for counts, day gaps and match scores.
* Signed amounts are from the holder's perspective (positive = inflow or asset, negative = outflow or debt).
  Ledger lines are debit-positive.
* `null` means unknown. Unknown is never turned into zero, and results that depend on it are marked
  `provisional` or `insufficient_data`.
* Outputs use `@financialos/contracts` types where a contract exists (`Explanation`, `Valuation`,
  `WealthSummary`, `ClearingAccountSummary`, `Reconciliation`, `CoverageGap`, `SplitLine`, …).
* Results are deterministic: every sort has a tie-breaker, and time comes in as an input (`now`, `asOf`).

## types.ts

| Export | Purpose |
|---|---|
| `IsoDateTime` | ISO-8601 instant string with offset. |
| `EntityInfo` | An entity as the engine sees it (kind, owner-controlled, primary owner, optional owner group). |
| `AccountInfo` | An account as the engine sees it (legal holder, economic owner, liquidity, currency). |
| `ExceptionSeverity` | `info`, `warning` or `critical`. |
| `ExceptionDescriptor` | A request to open an exception-inbox item, with a stable `dedupeKey`. |
| `TransactionLike` | Minimal transaction shape (id, account, date, signed amount, description, status). |
| `ValueInput` | A known-or-unknown value with its date, approximate flag and completeness. |

## explain.ts

| Export | Purpose |
|---|---|
| `SourceLinkKind`, `ExplanationRole` | Aliases for the contract enums. |
| `sourceLink`, `accountLink`, `transactionLink`, `snapshotLink`, `arrangementLink` | Build contract `SourceLink`s. |
| `ExplanationItemOptions` | Note, links and FX provenance for an explanation line. |
| `explanationItem` | Builds one `ExplanationItem` (links are de-duplicated). |
| `inputItem`, `addedItem`, `subtractedItem`, `excludedItem`, `assumptionItem`, `missingItem`, `resultItem` | Role-specific shortcuts for `explanationItem`. |
| `dedupeLinks` | Removes duplicate links and keeps their order. |
| `ExplanationParts`, `buildExplanation` | Build an `Explanation` with de-duplicated assumptions and missing notes. |
| `ExplanationBuilder` | Builds an explanation step by step (`input/added/subtracted/excluded/result/assume/missing/build`). |
| `ExceptionDescriptorInput`, `exceptionDescriptor` | Build an `ExceptionDescriptor` with key `kind:subjectType:subjectId[:discriminator]`. |

## split.ts

| Export | Purpose |
|---|---|
| `SplitShare` | A split part: a `weight` share of the remainder, or a `fixed` magnitude. |
| `splitAmount` | Splits a total exactly (fixed parts first, then the remainder by largest remainder). |
| `percentagesSumTo100` | Checks that percent parts sum to exactly 100. |
| `SplitError` | Raised when the shares cannot cover the total exactly. |

## ledger.ts: double-entry management ledger

| Export | Purpose |
|---|---|
| `LedgerAccountType`, `LEDGER_SYSTEM_ROLES`, `LedgerSystemRole`, `LedgerAccount`, `LedgerChart` | Chart of accounts (system roles: `fx_clearing`, `opening_balance_equity`, `third_party_clearing`, `intercompany_due`, `suspense`). |
| `JournalEntry`, `JournalLine`, `JournalEntryStatus`, `JournalEntryKind`, `JournalLineNature` | Immutable entries whose lines are debit-positive. `opening_balance` is a line nature that is never a flow. |
| `LedgerIssue`, `LedgerIssueCode`, `LedgerValidationResult`, `LedgerError`, `ImmutableEntryError` | Validation results and errors (`error.code`, `error.issues`). |
| `ValidateOptions`, `BuildOptions`, `EntryHeader`, `LineAttribution` | Shared builder and validator options. Pass `chart` to check accounts, entities, types and roles. |
| `chartOf` | Builds a chart map and refuses duplicate ids or unknown roles. |
| `findSystemAccount` | Finds an entity's system-role account, preferring one in the matching currency. |
| `validateEntry` / `assertValidEntry` | Checks: at least 2 lines, a valid date, no zero lines, amounts within currency precision, a zero sum per currency and per entity per currency, and consistent links. |
| `isMutable`, `assertMutable` | Only pending entries can be changed. |
| `buildIncomeExpenseEntry` | Simple income or expense. |
| `buildTransferEntry` | Same-currency transfer. Cross-entity transfers go through `intercompany_due` accounts. |
| `buildFxConversionEntry` | Trading-account conversion with one FX clearing line per currency. Metadata holds `impliedRate`, `ratePair` and, when given, the reference-rate deviation. |
| `buildSplitEntry` | One cash line against several P&L parts that sum exactly. |
| `buildFeeEntry` | Fee expense, optionally linked to the entry that caused it. |
| `buildRefundEntry` | Refund linked through `refundOfEntryId`. Cumulative refunds cannot exceed the original. |
| `reverseEntry` | Exact negation, linked both ways. Refuses reversed entries, reversals and pending entries. |
| `correctEntry` | Reversal plus replacement (`replacesEntryId`). |
| `buildOpeningBalanceEntry`, `OpeningBalanceBasis` | Verified opening position against `opening_balance_equity`. Owner-reported snapshots are valuation evidence, never journal entries. |
| `buildInvestmentTradeEntry`, `PositionMovement`, `InvestmentTradeResult` | Cash leg plus position leg at cost. The quantity is returned separately as a `PositionMovement`. |
| `buildDividendEntry` | Dividend with optional withholding tax. |
| `buildInterestEntry`, `InterestPaidInput` | Interest received (with optional withholding) or paid. |
| `postPendingEntry`, `amendPendingEntry`, `PendingAmendment` | Change pending entries. Posted ones are refused. |
| `entryCounts` | Whether an entry counts toward balances (posted and reversed do; pending only on request). |
| `computeLedgerBalances`, `LedgerBalance`, `BalanceOptions` | Balance per ledger account, entity and currency. |
| `ledgerAccountBalance` | One account's balance in one currency. |
| `trialBalance`, `TrialBalance`, `TrialBalanceRow` | Trial balance with per-currency totals. |
| `entityBalanceSheet`, `EntityBalanceSheet` | Natural-sign totals by type, with a per-currency accounting-equation check. |
| Input types: `IncomeExpenseInput`, `LedgerEndpoint`, `IntercompanyAccounts`, `TransferInput`, `FxConversionInput`, `SplitPartInput`, `SplitEntryInput`, `FeeInput`, `RefundInput`, `ReversalInput`, `ReversalResult`, `CorrectionResult`, `OpeningBalanceInput`, `InvestmentTradeInput`, `InvestmentIncomeInput` | Builder inputs and results. |

## classification.ts: rules engine and versions

| Export | Purpose |
|---|---|
| `RuleCondition`, `TextMatchOp` | Conditions: description or counterparty contains / startsWith / equals (normalised, no regex), amount range, direction, currency, account, card last-4. |
| `RuleActions`, `SplitTemplate`, `SplitTemplatePart`, `SplitTemplateShare` | Actions: category, nature, economic owner, split template (percent or fixed), tags. |
| `ClassificationRule`, `RuleConfidence` | A rule: priority (higher first, then id), kind `general` or `ownership`, confidence. |
| `ClassifiableTransaction`, `AccountOwnership`, `ClassifyOptions` | Classifier inputs: transaction with card last-4, account ownership, review threshold. |
| `ClassificationOutcome`, `ClassificationExplanationLine`, `ClassificationField`, `OwnerSource` | Result with confidence, `needsReview`, review reasons, matched rules and an explanation. |
| `normaliseText` | NFKC, lower case, collapsed whitespace. |
| `confidenceRank`, `minConfidence` | Order and combine `Confidence` values. |
| `hasIdentityCondition` | True when a rule identifies who is transacting (account, card, counterparty or description). |
| `validateRule`, `validateSplitTemplate` | Rule problems, including an owner set without an identity condition (never from currency alone). |
| `conditionMatches`, `ruleMatches`, `orderRules` | Matching primitives and the fixed evaluation order. |
| `applySplitTemplate` | Applies a template to a signed amount and returns contract `SplitLine`s. |
| `classifyTransaction`, `classifyTransactions` | Classifies transactions. Owner precedence: ownership rule > general rule > confirmed account owner > unknown. |
| `ClassificationMethod`, `ClassificationContent`, `ClassificationVersion`, `NextVersionResult`, `ClassificationVersionError` | Versioned classifications. |
| `contentFromOutcome` | Converts a rules outcome into version content. |
| `nextClassificationVersion` | Returns the next version without mutating the previous one. Protects owner (`user`) decisions, stops `model` output from deciding ownership, and skips unchanged content. |

## dedupe.ts: source-record identity

| Export | Purpose |
|---|---|
| `IncomingSourceRow`, `ExistingSourceRecord`, `RowIdentity`, `PlannedImportRow`, `ImportPlan`, `PlanImportOptions`, `ImportDecision`, `DedupeError` | Import planning types. |
| `stableHash` | Platform-independent, non-cryptographic 128-bit fingerprint. |
| `providerDedupeKey` | Key from (account, provider transaction id). |
| `tupleDedupeKey` | Key from (account, date, amount, currency, normalised description, occurrence index). |
| `sourceContentHash` | Hash of the fields whose change means an upstream revision. |
| `computeRowIdentities` | Keys, occurrence indexes and content hashes for one file. |
| `normaliseDescription`, `descriptionTokens`, `tokenSimilarity` | Description normalisation and Jaccard token similarity (as a decimal string). |
| `planImport` | Labels each row new, duplicate, possible_duplicate, pending_to_posted or changed_upstream, with explanations. Matching is 1:1, so repeated identical rows are kept. |

## reconciliation.ts

| Export | Purpose |
|---|---|
| `checkStatement`, `StatementCheckInput`, `StatementMovement`, `StatementCheckResult` | Checks opening + movements = closing. Returns the difference and an exception, never a balancing entry. |
| `toReconciliationRecord` | Maps a check to the contract `Reconciliation`. |
| `checkRunningBalance`, `BalanceRow`, `RowOrder`, `BalanceBreak`, `RunningBalanceResult` | Balance-column continuity with the first broken row. Detects newest-first files. |
| `detectCoverageGaps`, `CoveragePeriod`, `CoverageWindow`, `CoverageReport` | Gaps as contract `CoverageGap`s, plus missing and partial months and `missing_period` exceptions. |
| `coverageWindow` | Window of N calendar months ending at a date (e.g. 24 months). |
| `mergeCoverage` | Merges overlapping or adjacent periods. |
| `ReconciliationError` | Invalid periods or windows. |

## transfers.ts: transfer matching

| Export | Purpose |
|---|---|
| `matchTransfers` | Suggests one-to-one matches between outflows and inflows on different accounts, with a score, confidence and explanation (fee or FX deviation). |
| `TransferMatchOptions` | Window, fee and FX tolerances, `FxTable`, and the auto-confirm threshold and ambiguity margin. |
| `TransferMatchSuggestion`, `TransferMatchResult`, `TransferPair`, `TransferMatchState`, `EMPTY_TRANSFER_STATE` | Results and the owner's confirmed or rejected pairs. |
| `rejectTransferMatch` | Returns a new state. The pair is never suggested again. |
| `confirmTransferMatch` | Returns a new state. The confirmed transactions leave future matching. |

## consolidation.ts

| Export | Purpose |
|---|---|
| `ConsolidationFlow` | A signed flow in one entity's books, with an optional counterparty entity and pair id. |
| `consolidateFlows`, `ConsolidationResult`, `EliminatedFlow`, `EliminationReason`, `CurrencyTotals` | Eliminates flows whose both sides are in scope (salary, intercompany, personal ↔ business, matched transfers), keeps the rest, and warns about unbalanced pairs. |
| `entityFlowReport` | Scope of one entity: keeps every flow with other entities. |
| `toConsolidatedEliminations` | Maps eliminations to `ConsolidatedView['eliminated']`. |
| `flowsFromJournalEntries`, `FlowExtractionOptions` | Builds flows from journal lines on the `pnl` or `cash` basis. Skips opening balances and reversed pairs. |

## thirdParty.ts: third-party clearing

| Export | Purpose |
|---|---|
| `ThirdPartyArrangement`, `ThirdPartyMovement`, `ThirdPartyMovementKind`, `ThirdPartyClearingResult`, `ThirdPartyError` | Inputs and result types. |
| `feeDeductedFromReceipt` | fee = round(gross × rate), net = gross − fee. |
| `feeChargedOnTop` | principal = round(gross ÷ (1 + rate)), fee = gross − principal. |
| `computeClearingAccount` | Contract `ClearingAccountSummary` plus exceptions. In `unconfirmed` mode receipts are held, no fee income is recognised, and both alternatives are reported. |
| `attributableThirdPartyBalance`, `AttributionAccount`, `AttributionArrangement`, `AttributableItem`, `AttributableThirdPartyResult` | Money to exclude from owner wealth, income and spending capacity: whole third-party accounts plus positive clearing balances, never counted twice. |
| `attributableForAccount` | Attributable amounts inside one account (use this for safe-to-spend). |

## valuation.ts

| Export | Purpose |
|---|---|
| `selectValuation`, `ValuationInput`, `ValuationSettings`, `ValuationResult`, `ValuationCandidate` | Chooses one source (verified complete holdings > provider balance > statement closing > ledger > owner-reported) and returns contract `Valuation`, `Freshness`, the candidates and superseded snapshot ids. |
| `HoldingsSource`, `HoldingsSourceLine`, `ProviderBalanceSource`, `LedgerBalanceSource`, `ValuationBasis` | Source inputs. Provider "available" balances are never used. |
| `freshnessState` | `fresh`, `aging`, `stale` or `unknown` from `staleAfterHours` (aging defaults to half of it). |
| `valuationPrecedence` | Rank of a valuation basis. |

## wealth.ts

| Export | Purpose |
|---|---|
| `computeWealth` | Contract `WealthSummary` for the personal, consolidated or entity scope. |
| `computeWealthDetailed`, `WealthComputation`, `WealthDecision` | The same, plus the include or exclude decision for each account, interest and clearing item. |
| `WealthInput`, `WealthAccount`, `OwnershipInterest`, `WealthScope`, `WealthError` | Inputs. `creditLimit` and `buyingPower` are informational and never counted. |
| `SEGMENT_ORDER` | Fixed order of the nine liquidity segments. |
