# domain-planning

Forward-looking and behavioural calculations, on top of `domain-core`. Pure TypeScript, no I/O. Everything is
exported from `@financialos/domain` through `src/index.ts` (see `index.ts` for the exact list;
`explain-local.ts` and `testing.ts` are deliberately not exported).

The conventions in [`../core/README.md`](../core/README.md) apply here too:

* Money is `{ amount: decimal string, currency }` and the arithmetic uses `Decimal` (`../money`). JS numbers are
  used only for counts, day gaps and match scores.
* `null` means unknown. Unknown is never turned into zero, and results that depend on it are marked
  `provisional` or `insufficient_data`.
* Time is an input (`now`, `today`, `asOf`). Nothing here reads the clock, and every sort has a tie-breaker, so
  the same input always produces the same output.
* Anything computed is explainable: an `Explanation` (via `explain-local.ts`), a `reason`, or the numbers used.

| Module | Purpose |
|---|---|
| `types.ts` | Planning-shaped `PlanningEntity` / `PlanningAccount` / `ThirdPartyHolding` inputs. |
| `shared.ts` | Errors, deterministic ids, decimal formatting, FX conversion, label normalisation, medians. |
| `explain-local.ts` | Planning-side `ExplanationBuilder` (not exported from the package). |
| `cashflow.ts` | Dated cash-flow projection; recurring / obligation / receivable expansion. |
| `safeToSpend.ts` | Eligible personal cash less third-party money, obligations and protected reserves. |
| `runway.ts` | Months of runway, or an honest `not_depleting` / `insufficient_history`. |
| `forecast.ts` | Thirteen-week cash forecast. |
| `scenarios.ts` | Reversible what-if adjustments over cash-flow items. |
| `budget.ts` | Budgets, envelopes and sinking funds, actual vs plan. |
| `purchaseImpact.ts` | What one purchase does to safe-to-spend, commitments, reserves and goals. |
| `goals.ts` | Goal progress from verified and planned contributions. |
| `interest.ts` | Nominal vs effective rates, compounding, accrued interest. |
| `restricted.ts` | Sale schedules from verified restriction terms; indicative value, never proceeds. |
| `portfolio.ts` | Allocation, exposure, concentration, cost basis, income, TWR / XIRR performance. |
| `paperTrading.ts` | Paper-trade risk checks. Live execution is always disabled. |
| `rewards.ts` | Card rewards net of fees and FX, from owner-entered dated terms. |
| `recurring.ts` | Detects recurring series, price changes and missed occurrences from history. |
| `anomalies.ts` | Unusual-transaction detection with robust statistics. |
| `alerts.ts` | Alert rules to notification descriptors, with dedupe keys and quiet hours. |
| `coach.ts` | The deterministic, non-AI coach: next actions, reviews, grounded answers. |
| `achievements.ts` | Awards on verified evidence only. |
| `completeness.ts` | Transparent data-completeness indicator (explicitly not a health score). |
| `testing.ts` | Synthetic fixtures for the tests in this folder (not exported). |

## recurring.ts

| Export | Purpose |
|---|---|
| `RecurringTransaction`, `ExistingRecurring`, `RecurringDetectionInput`, `RecurringDetectionOptions` | Inputs: signed transactions, items the owner already tracks, thresholds. |
| `CADENCE_BANDS`, `cadenceBand` | Interval bands (weekly 5–9, fortnightly 12–17, monthly 25–35, quarterly 80–100, annually 330–400 days) and their grace periods. |
| `inferCadence`, `CadenceInference` | Cadence from the median interval, plus the share of intervals inside the band. |
| `nextExpectedDate` | One cadence step on, with month-end clamping. |
| `detectRecurring`, `RecurringDetectionResult` | Suggestions, price changes, missed occurrences, and every series examined. |
| `RecurringSeries`, `RecurringOccurrence`, `RecurringSuggestion` | The numbers behind a decision: occurrences, intervals, regularity, amount spread, confidence. |
| `SubscriptionPriceChange` | Latest occurrence against the median of the earlier ones, beyond a threshold. |
| `MissedOccurrence` | An expected occurrence that passed its grace period. |
| `recurringSuggestions`, `suggestionAmount` | Convenience wrappers. |

Suggestions are never auto-confirmed: `status: 'suggested'`, `detected: true`, `confirmed: false`. Three
occurrences are required (two for an annual series), and an amount that varied at all is an estimate.

## anomalies.ts

| Export | Purpose |
|---|---|
| `AnomalyTransaction`, `AnomalyInput`, `AnomalyOptions` | Inputs: full history, the window to report on, thresholds, the home currency and FX table. |
| `medianAbsoluteDeviation`, `meanAbsoluteDeviation`, `robustSpread`, `robustZScore`, `RobustSpread` | Robust statistics: `z = (x − median) / (MAD / 0.6745)`, with a mean-absolute-deviation fallback. |
| `AnomalyKind`, `Anomaly`, `AnomalyNumbers`, `SpreadBasis` | A finding with its reason, the numbers used, its links and an `unusual_transaction` exception descriptor. |
| `detectAnomalies`, `AnomalyResult`, `AnomalySkip` | Category, counterparty, first-seen, duplicate-charge and foreign-currency checks, plus what could not be assessed. |
| `ANOMALY_NOTE` | The wording attached to every finding: unusual, worth a look, never a claim about conduct. |

## alerts.ts

| Export | Purpose |
|---|---|
| `AlertKind`, `AlertSeverity`, `AlertDescriptor`, `AlertEvaluation` | A notification descriptor with `why`, `shortBody`, `dedupeKey`, `periodKey` and `deliverAt`. |
| `AlertInput` and its sources (`UpcomingBillSource`, `RunwayAlertSource`, `ConnectionAlertSource`, `CoverageGapAlertSource`, `ReviewAlertSource`) | The facts each rule reads. |
| `evaluateAlerts` | Upcoming bill, runway below threshold, subscription price change, unusual transaction, coverage gap, stale connection, weekly review, monthly close, business cash warning. |
| `PRIVACY_SAFE_BODY` | Privacy-safe wording for external channels: no amounts, names, account identifiers or digits. |
| `QuietHours`, `parseClock`, `inQuietHours`, `nextAllowedTime`, `localClock`, `zonedTimeToInstant` | Quiet hours in the reporting time zone, including windows that cross midnight. Critical alerts are never deferred. |
| `isoWeekKey` | ISO week-year key (`2026-W11`) used in period keys. |
| `toNotification` | Maps a descriptor onto the contract `Notification`. |

## coach.ts

| Export | Purpose |
|---|---|
| `CoachFacts` and its parts (`CoachException`, `CoachConnection`, `CoachThirdParty`, `CoachReconciliationPeriod`, `CoachReserve`, `CoachCategorySpend`, `CoachBudgetLine`, `CoachReviewState`, `CoachNewRecurring`, `CoachPeriod`) | Everything the coach is allowed to use. It never reaches past this object. |
| `nextActions` | The top three contract `NextAction`s, ranked by impact across exceptions, connections, fee policy, reconciliation, reserves and reviews. |
| `buildReview` | A contract `Review`: what changed, why it matters, exactly one next action, a checklist, source links on every section. |
| `answerDeterministic`, `routeQuestion`, `CoachTopic`, `CoachAnswer`, `SUPPORTED_QUESTIONS` | Keyword-routed answers; anything else returns an honest "here is what I can answer from your records". |
| `toCoachMessage`, `COACH_GENERATED_BY` | Wraps an answer as a contract `CoachMessage`. `generatedBy` is always `'deterministic'`. |

Tone is direct, calm and non-shaming: no flattery, no exclamation marks, and no moralising about enjoyable
purchases, though a trade-off against a stated goal is named in plain numbers.

## achievements.ts

| Export | Purpose |
|---|---|
| `AchievementInput` and its evidence types (`CompletedReviewEvidence`, `ReconciledPeriodEvidence`, `GoalContributionEvidence`, `MonthlySavingEvidence`, `ExceptionClearanceEvidence`) | Verified evidence only. |
| `awardAchievements`, `AchievementResult`, `SkippedAward` | Awards plus a reason for every rejection. |
| `weeklyStreak`, `StreakSummary` | Runs of consecutive completed weekly reviews. |
| `NEVER_AWARDED_FOR` | The enforced exclusions: trading frequency, spending, credit utilisation, market appreciation, planned-only actions. |

## completeness.ts

| Export | Purpose |
|---|---|
| `dataCompleteness`, `DataCompletenessInput`, `DataCompletenessResult`, `CompletenessAccount`, `CompletenessComponent`, `CompletenessComponentId` | Fresh balances, months of coverage against 24, classified share and reconciled share, equally weighted, with the formula, the weighting and the limitations in the output. |
| `NOT_A_HEALTH_SCORE` | The disclaimer carried in every result. |

A component that cannot be measured is dropped from the formula and listed as a limitation; the rest keep
equal weights. Below two measurable components no aggregate is given at all.
