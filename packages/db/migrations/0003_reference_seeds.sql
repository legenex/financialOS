-- Hand-written: idempotent reference data. Nothing here is owner data.
-- Every insert skips rows that already exist, so re-running never overwrites owner edits.

-- Setup state singleton ------------------------------------------------------------
INSERT INTO setup_state (id, state) VALUES (1, 'awaiting_bootstrap_secret')
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- Currencies (snapshot of listCurrencies() from @financialos/domain; migrate also tops
-- up any registry entries added later) ------------------------------------------------
INSERT INTO currencies (code, name, minor_units, kind) VALUES
  ('USD', 'US dollar', 2, 'fiat'),
  ('ZAR', 'South African rand', 2, 'fiat'),
  ('GBP', 'Pound sterling', 2, 'fiat'),
  ('EUR', 'Euro', 2, 'fiat'),
  ('AED', 'UAE dirham', 2, 'fiat'),
  ('CHF', 'Swiss franc', 2, 'fiat'),
  ('CAD', 'Canadian dollar', 2, 'fiat'),
  ('AUD', 'Australian dollar', 2, 'fiat'),
  ('NZD', 'New Zealand dollar', 2, 'fiat'),
  ('SGD', 'Singapore dollar', 2, 'fiat'),
  ('HKD', 'Hong Kong dollar', 2, 'fiat'),
  ('SEK', 'Swedish krona', 2, 'fiat'),
  ('NOK', 'Norwegian krone', 2, 'fiat'),
  ('DKK', 'Danish krone', 2, 'fiat'),
  ('PLN', 'Polish zloty', 2, 'fiat'),
  ('CZK', 'Czech koruna', 2, 'fiat'),
  ('INR', 'Indian rupee', 2, 'fiat'),
  ('CNY', 'Chinese yuan', 2, 'fiat'),
  ('MXN', 'Mexican peso', 2, 'fiat'),
  ('BRL', 'Brazilian real', 2, 'fiat'),
  ('SAR', 'Saudi riyal', 2, 'fiat'),
  ('QAR', 'Qatari riyal', 2, 'fiat'),
  ('NAD', 'Namibian dollar', 2, 'fiat'),
  ('BWP', 'Botswana pula', 2, 'fiat'),
  ('MUR', 'Mauritian rupee', 2, 'fiat'),
  ('KES', 'Kenyan shilling', 2, 'fiat'),
  ('NGN', 'Nigerian naira', 2, 'fiat'),
  ('ILS', 'Israeli new shekel', 2, 'fiat'),
  ('TRY', 'Turkish lira', 2, 'fiat'),
  ('THB', 'Thai baht', 2, 'fiat'),
  ('JPY', 'Japanese yen', 0, 'fiat'),
  ('KRW', 'South Korean won', 0, 'fiat'),
  ('HUF', 'Hungarian forint', 2, 'fiat'),
  ('BHD', 'Bahraini dinar', 3, 'fiat'),
  ('KWD', 'Kuwaiti dinar', 3, 'fiat'),
  ('OMR', 'Omani rial', 3, 'fiat'),
  ('JOD', 'Jordanian dinar', 3, 'fiat'),
  ('BTC', 'Bitcoin', 8, 'crypto'),
  ('ETH', 'Ether', 18, 'crypto'),
  ('USDC', 'USD Coin', 6, 'crypto'),
  ('USDT', 'Tether USD', 6, 'crypto'),
  ('SOL', 'Solana', 9, 'crypto')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- Application settings defaults (AppSettings in @financialos/contracts) ---------------
INSERT INTO settings (key, value, updated_by) VALUES
  ('reportingCurrency', '"USD"'::jsonb, 'migration'),
  ('budgetCurrency', '"ZAR"'::jsonb, 'migration'),
  ('reportingTimezone', '"Africa/Johannesburg"'::jsonb, 'migration'),
  ('safeToSpendHorizonDays', '30'::jsonb, 'migration'),
  ('safeToSpendHorizonBasis', '"fixed_days"'::jsonb, 'migration'),
  ('includeNearCashInSafeToSpend', 'false'::jsonb, 'migration'),
  ('runwayMinimumHistoryMonths', '3'::jsonb, 'migration'),
  ('staleAfterHours', '48'::jsonb, 'migration'),
  ('idleTimeoutSeconds', '300'::jsonb, 'migration'),
  ('privacyModeDefault', 'true'::jsonb, 'migration'),
  ('quietHours', '{"enabled": true, "start": "22:00", "end": "07:00"}'::jsonb, 'migration'),
  ('weekStartsOn', '"monday"'::jsonb, 'migration'),
  ('cloudAiAllowed', 'false'::jsonb, 'migration'),
  ('publicMarketDataEnabled', 'false'::jsonb, 'migration')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- Generic default category tree ------------------------------------------------------
INSERT INTO categories (seed_key, parent_id, name, kind, essential, system) VALUES
  ('housing', NULL, 'Housing', 'expense', true, true),
  ('utilities', NULL, 'Utilities', 'expense', true, true),
  ('groceries', NULL, 'Groceries', 'expense', true, true),
  ('dining', NULL, 'Dining', 'expense', false, true),
  ('transport', NULL, 'Transport', 'expense', true, true),
  ('travel', NULL, 'Travel', 'expense', false, true),
  ('health', NULL, 'Health', 'expense', true, true),
  ('insurance', NULL, 'Insurance', 'expense', true, true),
  ('subscriptions', NULL, 'Subscriptions', 'expense', false, true),
  ('software', NULL, 'Software', 'expense', false, true),
  ('education', NULL, 'Education', 'expense', false, true),
  ('gifts_donations', NULL, 'Gifts & donations', 'expense', false, true),
  ('personal_care', NULL, 'Personal care', 'expense', false, true),
  ('entertainment', NULL, 'Entertainment', 'expense', false, true),
  ('fees_charges', NULL, 'Fees & charges', 'expense', false, true),
  ('taxes', NULL, 'Taxes', 'expense', true, true),
  ('income', NULL, 'Income', 'income', false, true),
  ('transfers', NULL, 'Transfers', 'transfer', false, true)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO categories (seed_key, parent_id, name, kind, essential, system)
SELECT child.seed_key, parent.id, child.name, 'income', false, true
FROM (VALUES
  ('income.salary', 'Salary'),
  ('income.business', 'Business income'),
  ('income.interest', 'Interest'),
  ('income.dividends', 'Dividends'),
  ('income.refunds', 'Refunds')
) AS child (seed_key, name)
CROSS JOIN LATERAL (
  SELECT c.id FROM categories c
  WHERE c.seed_key = 'income' OR (c.parent_id IS NULL AND c.name = 'Income')
  ORDER BY (c.seed_key = 'income') DESC NULLS LAST
  LIMIT 1
) AS parent
ON CONFLICT DO NOTHING;
