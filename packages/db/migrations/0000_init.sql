CREATE TABLE "agent_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"credential_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"entity_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "agent_clients_credential_hash_key" UNIQUE("credential_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"object_type" text,
	"object_id" text,
	"entity_id" uuid,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"ip_hash" text,
	CONSTRAINT "audit_events_actor_type_check" CHECK (actor_type IN ('owner', 'system', 'worker', 'agent', 'device', 'anonymous'))
);
--> statement-breakpoint
CREATE TABLE "device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" text NOT NULL,
	"verifier_challenge" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"device_label" text NOT NULL,
	"extension_origin" text NOT NULL,
	"extension_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_label" text,
	"approved_expires_days" integer,
	"denied_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"device_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"kind" text DEFAULT 'chrome_extension' NOT NULL,
	"extension_origin" text NOT NULL,
	"installation_id" text NOT NULL,
	"credential_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"revealed_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_access_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "devices_credential_hash_key" UNIQUE("credential_hash")
);
--> statement-breakpoint
CREATE TABLE "launch_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce_hash" text NOT NULL,
	"target" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_session_id" uuid,
	CONSTRAINT "launch_requests_nonce_hash_key" UNIQUE("nonce_hash")
);
--> statement-breakpoint
CREATE TABLE "login_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"first_failure_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failure_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "owner_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"totp_secret_ciphertext" text,
	"totp_enabled_at" timestamp with time zone,
	"totp_last_used_step" bigint,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"auth_method" text NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"user_agent" text,
	"ip_hash" text,
	"origin" text,
	"launch_request_id" uuid,
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "sessions_absolute_lifetime_check" CHECK (absolute_expires_at <= authenticated_at + interval '600 seconds')
);
--> statement-breakpoint
CREATE TABLE "setup_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'awaiting_bootstrap_secret' NOT NULL,
	"bootstrap_secret_hash" text,
	"bootstrap_consumed_at" timestamp with time zone,
	"setup_token_hash" text,
	"setup_token_expires_at" timestamp with time zone,
	"owner_created_at" timestamp with time zone,
	"totp_verified_at" timestamp with time zone,
	"recovery_codes_issued_at" timestamp with time zone,
	"passkey_enrolled_at" timestamp with time zone,
	"sealed_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_state_singleton" CHECK (id = 1),
	CONSTRAINT "setup_state_state_check" CHECK (state IN ('awaiting_bootstrap_secret', 'in_progress', 'sealed'))
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"challenge" text NOT NULL,
	"rp_id" text NOT NULL,
	"origin" text NOT NULL,
	"binding" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "webauthn_challenges_purpose_check" CHECK (purpose IN ('register', 'authenticate'))
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"rp_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "webauthn_credentials_credential_id_key" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"minor_units" smallint NOT NULL,
	"kind" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "currencies_code_check" CHECK (code ~ '^[A-Z0-9]{2,10}$'),
	CONSTRAINT "currencies_minor_units_check" CHECK (minor_units BETWEEN 0 AND 18),
	CONSTRAINT "currencies_kind_check" CHECK (kind IN ('fiat', 'crypto', 'other'))
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric(38, 18) NOT NULL,
	"as_of" date NOT NULL,
	"source" text NOT NULL,
	"kind" text DEFAULT 'reference' NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_base_quote_as_of_source_key" UNIQUE("base","quote","as_of","source"),
	CONSTRAINT "fx_rates_positive_check" CHECK (rate > 0),
	CONSTRAINT "fx_rates_distinct_check" CHECK (base <> quote),
	CONSTRAINT "fx_rates_kind_check" CHECK (kind IN ('reference', 'market', 'manual', 'implied'))
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"price_kind" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prices_instrument_as_of_source_key" UNIQUE("instrument_id","as_of","source"),
	CONSTRAINT "prices_non_negative_check" CHECK (price >= 0),
	CONSTRAINT "prices_kind_check" CHECK (price_kind IN ('real_time', 'delayed', 'end_of_day', 'manual', 'statement', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'unknown' NOT NULL,
	"entity_id" uuid,
	"normalized_name" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparties_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "counterparties_kind_check" CHECK (kind IN ('person', 'business', 'government', 'internal', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"jurisdiction" text,
	"base_currency" text,
	"owner_controlled" boolean DEFAULT false NOT NULL,
	"primary_owner" boolean DEFAULT false NOT NULL,
	"legal_status_confirmed" boolean DEFAULT false NOT NULL,
	"notes" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bootstrap_key" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "entities_kind_check" CHECK (kind IN ('person', 'company', 'trust', 'third_party')),
	CONSTRAINT "entities_primary_owner_is_person_check" CHECK (NOT primary_owner OR kind = 'person'),
	CONSTRAINT "entities_third_party_not_owner_controlled_check" CHECK (kind <> 'third_party' OR NOT owner_controlled)
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"kind" text NOT NULL,
	"provider_key" text,
	"notes" text,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institutions_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "institutions_kind_check" CHECK (kind IN ('bank', 'broker', 'wallet', 'fund', 'issuer', 'lender', 'other'))
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"currency" text,
	"exchange" text,
	"isin" text,
	"identifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "instruments_identity_key" UNIQUE NULLS NOT DISTINCT("kind","symbol","exchange"),
	CONSTRAINT "instruments_kind_check" CHECK (kind IN ('equity', 'etf', 'fund', 'crypto', 'bond', 'cash', 'private_note', 'restricted_equity', 'other'))
);
--> statement-breakpoint
CREATE TABLE "ownership_interests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holder_entity_id" uuid NOT NULL,
	"held_entity_id" uuid NOT NULL,
	"percent" numeric(38, 18),
	"confirmed" boolean DEFAULT false NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"notes" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownership_interests_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "ownership_interests_distinct_check" CHECK (holder_entity_id <> held_entity_id),
	CONSTRAINT "ownership_interests_percent_check" CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100))
);
--> statement-breakpoint
CREATE TABLE "account_ownership_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"match_kind" text NOT NULL,
	"pattern" text NOT NULL,
	"economic_owner_entity_id" uuid NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_ownership_rules_match_kind_check" CHECK (match_kind IN ('card_last4', 'card_id', 'description_pattern', 'counterparty')),
	CONSTRAINT "account_ownership_rules_last4_check" CHECK (match_kind <> 'card_last4' OR pattern ~ '^[0-9]{4}$'),
	CONSTRAINT "account_ownership_rules_card_id_digits_check" CHECK (match_kind <> 'card_id' OR length(regexp_replace(pattern, '[^0-9]', '', 'g')) <= 4)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"currency" text,
	"institution_id" uuid,
	"legal_entity_id" uuid,
	"economic_owner_entity_id" uuid,
	"ownership_confirmed" boolean DEFAULT false NOT NULL,
	"liquidity_class" text NOT NULL,
	"include_in_safe_to_spend" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"masked_identifier" text,
	"notes" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_from" text NOT NULL,
	"connection_id" uuid,
	"opened_on" date,
	"closed_on" date,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "accounts_kind_check" CHECK (kind IN ('current', 'savings', 'card', 'credit_card', 'brokerage', 'crypto_wallet', 'crypto_custodial', 'private_investment', 'restricted_equity', 'pension', 'property', 'mortgage', 'loan', 'receivable', 'clearing', 'other')),
	CONSTRAINT "accounts_liquidity_class_check" CHECK (liquidity_class IN ('cash', 'near_cash', 'marketable', 'restricted', 'illiquid', 'property', 'liability', 'receivable', 'contingent')),
	CONSTRAINT "accounts_status_check" CHECK (status IN ('active', 'closed')),
	CONSTRAINT "accounts_created_from_check" CHECK (created_from IN ('bootstrap', 'user', 'provider')),
	CONSTRAINT "accounts_masked_identifier_check" CHECK (masked_identifier IS NULL OR (length(masked_identifier) <= 32 AND length(regexp_replace(masked_identifier, '[^0-9]', '', 'g')) <= 4))
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"source_as_of" timestamp with time zone,
	"approximate" boolean DEFAULT false NOT NULL,
	"completeness" text DEFAULT 'unknown' NOT NULL,
	"composition" jsonb,
	"source" text NOT NULL,
	"superseded_by" uuid,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"document_id" uuid,
	"import_batch_id" uuid,
	"connection_id" uuid,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_snapshots_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "balance_snapshots_kind_check" CHECK (kind IN ('owner_reported_total', 'statement_opening', 'statement_closing', 'provider_current', 'provider_available', 'opening', 'manual')),
	CONSTRAINT "balance_snapshots_completeness_check" CHECK (completeness IN ('complete', 'partial', 'unknown')),
	CONSTRAINT "balance_snapshots_not_self_superseded_check" CHECK (superseded_by IS NULL OR superseded_by <> id)
);
--> statement-breakpoint
CREATE TABLE "corporate_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effective_date" date,
	"ratio_from" numeric(38, 18),
	"ratio_to" numeric(38, 18),
	"status" text DEFAULT 'unverified' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corporate_actions_kind_check" CHECK (kind IN ('split', 'reverse_split', 'dividend', 'spinoff', 'merger', 'symbol_change', 'listing_change', 'other')),
	CONSTRAINT "corporate_actions_status_check" CHECK (status IN ('announced', 'unverified', 'verified', 'applied'))
);
--> statement-breakpoint
CREATE TABLE "fixed_income_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"principal" numeric(38, 18),
	"currency" text,
	"stated_annual_rate" numeric(38, 18),
	"rate_basis" text DEFAULT 'unverified' NOT NULL,
	"compounding" text DEFAULT 'unknown' NOT NULL,
	"fees" text,
	"withdrawal_terms" text,
	"counterparty_id" uuid,
	"counterparty_name" text,
	"start_date" date,
	"maturity_date" date,
	"verified" boolean DEFAULT false NOT NULL,
	"notes" text,
	"document_id" uuid,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_income_terms_account_key" UNIQUE("account_id"),
	CONSTRAINT "fixed_income_terms_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "fixed_income_terms_rate_basis_check" CHECK (rate_basis IN ('nominal', 'effective', 'unverified')),
	CONSTRAINT "fixed_income_terms_compounding_check" CHECK (compounding IN ('monthly', 'quarterly', 'annually', 'daily', 'simple', 'unknown')),
	CONSTRAINT "fixed_income_terms_verified_basis_check" CHECK (NOT verified OR rate_basis <> 'unverified')
);
--> statement-breakpoint
CREATE TABLE "holding_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"quantity" numeric(38, 18),
	"price" numeric(38, 18),
	"price_currency" text,
	"price_as_of" timestamp with time zone,
	"price_source" text,
	"price_kind" text,
	"value" numeric(38, 18),
	"value_currency" text,
	"cost_basis" numeric(38, 18),
	"cost_basis_currency" text,
	"cost_basis_complete" boolean DEFAULT false NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_lines_value_currency_check" CHECK (value IS NULL OR value_currency IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "holdings_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"source_as_of" timestamp with time zone,
	"completeness" text DEFAULT 'unknown' NOT NULL,
	"source" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"superseded_by" uuid,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"document_id" uuid,
	"import_batch_id" uuid,
	"connection_id" uuid,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holdings_snapshots_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "holdings_snapshots_completeness_check" CHECK (completeness IN ('complete', 'partial', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "investment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid,
	"source_record_id" uuid,
	"kind" text NOT NULL,
	"trade_date" date NOT NULL,
	"settle_date" date,
	"quantity" numeric(38, 18),
	"price" numeric(38, 18),
	"amount" numeric(38, 18),
	"currency" text,
	"fees" numeric(38, 18),
	"fee_currency" text,
	"external_id" text,
	"journal_entry_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_transactions_kind_check" CHECK (kind IN ('buy', 'sell', 'dividend', 'interest', 'fee', 'tax', 'deposit', 'withdrawal', 'transfer_in', 'transfer_out', 'split', 'corporate_action', 'other'))
);
--> statement-breakpoint
CREATE TABLE "liability_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"principal" numeric(38, 18),
	"currency" text,
	"interest_rate" numeric(38, 18),
	"rate_basis" text DEFAULT 'unverified' NOT NULL,
	"rate_type" text DEFAULT 'unknown' NOT NULL,
	"payment_amount" numeric(38, 18),
	"payment_cadence" text,
	"term_months" integer,
	"credit_limit" numeric(38, 18),
	"start_date" date,
	"maturity_date" date,
	"lender_counterparty_id" uuid,
	"secured_by_account_id" uuid,
	"verified" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "liability_terms_account_key" UNIQUE("account_id"),
	CONSTRAINT "liability_terms_rate_basis_check" CHECK (rate_basis IN ('nominal', 'effective', 'unverified')),
	CONSTRAINT "liability_terms_rate_type_check" CHECK (rate_type IN ('fixed', 'variable', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "property_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"label" text,
	"country" text,
	"purchase_date" date,
	"purchase_price" numeric(38, 18),
	"purchase_currency" text,
	"valuation" numeric(38, 18),
	"valuation_currency" text,
	"valuation_as_of" date,
	"valuation_source" text,
	"ownership_share" numeric(38, 18),
	"mortgage_account_id" uuid,
	"verified" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_details_account_key" UNIQUE("account_id"),
	CONSTRAINT "property_details_share_check" CHECK (ownership_share IS NULL OR (ownership_share > 0 AND ownership_share <= 1))
);
--> statement-breakpoint
CREATE TABLE "restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"instrument_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'reported_unverified' NOT NULL,
	"terms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"document_id" uuid,
	"notes" text,
	"verified_at" timestamp with time zone,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restrictions_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "restrictions_kind_check" CHECK (kind IN ('volume_cap', 'lockup', 'vesting', 'transfer_restriction', 'other')),
	CONSTRAINT "restrictions_status_check" CHECK (status IN ('reported_unverified', 'verified', 'expired', 'rejected')),
	CONSTRAINT "restrictions_verified_at_check" CHECK (status <> 'verified' OR verified_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "watch_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid,
	"account_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"expected_date" date,
	"notes" text,
	"source_url" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_events_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "watch_events_status_check" CHECK (status IN ('unverified', 'verified', 'occurred', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"kind" text DEFAULT 'transaction' NOT NULL,
	"source_record_id" uuid,
	"import_batch_id" uuid,
	"idempotency_key" text,
	"reverses_entry_id" uuid,
	"reversed_by_entry_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"posted_at" timestamp with time zone,
	"created_by" text DEFAULT 'system' NOT NULL,
	"memo" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "journal_entries_status_check" CHECK (status IN ('draft', 'posted', 'reversed')),
	CONSTRAINT "journal_entries_kind_check" CHECK (kind IN ('transaction', 'opening_balance', 'adjustment', 'reversal', 'transfer', 'fx_conversion', 'intercompany', 'clearing', 'investment')),
	CONSTRAINT "journal_entries_posted_at_check" CHECK (status = 'draft' OR posted_at IS NOT NULL),
	CONSTRAINT "journal_entries_reversed_check" CHECK ((status = 'reversed') = (reversed_by_entry_id IS NOT NULL AND reversed_at IS NOT NULL)),
	CONSTRAINT "journal_entries_not_self_reversing_check" CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"fx_rate" numeric(38, 18),
	"reporting_amount" numeric(38, 18),
	"reporting_currency" text,
	"memo" text,
	"category_id" uuid,
	"counterparty_id" uuid,
	"economic_owner_entity_id" uuid,
	"source_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_entry_line_key" UNIQUE("entry_id","line_no"),
	CONSTRAINT "journal_lines_non_zero_check" CHECK (amount <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"subtype" text NOT NULL,
	"currency" text,
	"account_id" uuid,
	"counterparty_entity_id" uuid,
	"arrangement_id" uuid,
	"category_id" uuid,
	"system" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_entity_code_key" UNIQUE("entity_id","code"),
	CONSTRAINT "ledger_accounts_type_check" CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
	CONSTRAINT "ledger_accounts_subtype_check" CHECK (subtype IN ('bank', 'investment', 'receivable', 'payable', 'opening_balance_equity', 'fx_clearing', 'third_party_clearing', 'intercompany_due_to', 'intercompany_due_from', 'suspense', 'owner_equity', 'income', 'expense', 'fee_income', 'other'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"essential" boolean DEFAULT false NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"seed_key" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_seed_key_key" UNIQUE("seed_key"),
	CONSTRAINT "categories_parent_name_key" UNIQUE NULLS NOT DISTINCT("parent_id","name"),
	CONSTRAINT "categories_kind_check" CHECK (kind IN ('expense', 'income', 'transfer', 'other'))
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"nature" text NOT NULL,
	"category_id" uuid,
	"economic_owner_entity_id" uuid,
	"counterparty_id" uuid,
	"splits" jsonb,
	"confidence" text DEFAULT 'none' NOT NULL,
	"method" text NOT NULL,
	"rule_id" uuid,
	"transfer_match_id" uuid,
	"needs_review" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classifications_record_version_key" UNIQUE("source_record_id","version"),
	CONSTRAINT "classifications_version_check" CHECK (version >= 1),
	CONSTRAINT "classifications_nature_check" CHECK (nature IN ('consumption', 'income', 'salary', 'transfer_internal', 'transfer_external', 'intercompany', 'owner_contribution', 'owner_drawing', 'business_support', 'third_party', 'investment_contribution', 'investment_withdrawal', 'investment_trade', 'property_purchase', 'loan_repayment', 'fee', 'interest', 'dividend', 'refund', 'tax', 'payroll', 'fx_conversion', 'unknown')),
	CONSTRAINT "classifications_confidence_check" CHECK (confidence IN ('high', 'medium', 'low', 'none')),
	CONSTRAINT "classifications_method_check" CHECK (method IN ('rule', 'user', 'model', 'provider', 'transfer_match', 'bootstrap', 'none'))
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"match" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"entity_id" uuid,
	"account_id" uuid,
	"created_from" text DEFAULT 'user' NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_record_tags" (
	"source_record_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_record_tags_pkey" PRIMARY KEY("source_record_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"record_kind" text DEFAULT 'transaction' NOT NULL,
	"connection_id" uuid,
	"import_batch_id" uuid,
	"document_id" uuid,
	"provider_id" text,
	"dedupe_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"upstream_version" integer DEFAULT 1 NOT NULL,
	"raw" jsonb NOT NULL,
	"booked_on" date,
	"value_on" date,
	"source_timezone" text,
	"amount" numeric(38, 18),
	"currency" text,
	"description" text,
	"counterparty_name" text,
	"reference" text,
	"balance_after" numeric(38, 18),
	"pending" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_by" uuid,
	"deleted_upstream_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_records_account_dedupe_key" UNIQUE("account_id","dedupe_key"),
	CONSTRAINT "source_records_origin_check" CHECK (origin IN ('import', 'provider_api', 'manual')),
	CONSTRAINT "source_records_kind_check" CHECK (record_kind IN ('transaction', 'balance', 'holding', 'investment_transaction', 'other')),
	CONSTRAINT "source_records_amount_currency_check" CHECK (amount IS NULL OR currency IS NOT NULL),
	CONSTRAINT "source_records_not_self_superseded_check" CHECK (superseded_by IS NULL OR superseded_by <> id)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_key" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "third_party_arrangements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"third_party_entity_id" uuid NOT NULL,
	"currency" text,
	"fee_rate" numeric(38, 18),
	"fee_mode" text DEFAULT 'unconfirmed' NOT NULL,
	"fee_mode_confirmed" boolean DEFAULT false NOT NULL,
	"fee_recipient_entity_id" uuid,
	"opening_balance" numeric(38, 18),
	"opening_balance_as_of" date,
	"holding_entity_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"clearing_account_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"economically_owned_account_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"evidence_note" text,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "third_party_arrangements_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "third_party_arrangements_fee_mode_check" CHECK (fee_mode IN ('deducted_from_receipt', 'charged_on_top', 'unconfirmed')),
	CONSTRAINT "third_party_arrangements_confirmed_mode_check" CHECK (NOT fee_mode_confirmed OR fee_mode <> 'unconfirmed'),
	CONSTRAINT "third_party_arrangements_fee_rate_check" CHECK (fee_rate IS NULL OR (fee_rate >= 0 AND fee_rate < 1)),
	CONSTRAINT "third_party_arrangements_status_check" CHECK (status IN ('active', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "transfer_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_source_record_id" uuid NOT NULL,
	"to_source_record_id" uuid NOT NULL,
	"confidence" text NOT NULL,
	"score" numeric(38, 18),
	"explanation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"fx_rate" numeric(38, 18),
	"fee_amount" numeric(38, 18),
	"fee_currency" text,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_matches_pair_key" UNIQUE("from_source_record_id","to_source_record_id"),
	CONSTRAINT "transfer_matches_distinct_check" CHECK (from_source_record_id <> to_source_record_id),
	CONSTRAINT "transfer_matches_confidence_check" CHECK (confidence IN ('high', 'medium', 'low', 'none')),
	CONSTRAINT "transfer_matches_status_check" CHECK (status IN ('suggested', 'confirmed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "coverage_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"source" text NOT NULL,
	"import_batch_id" uuid,
	"connection_id" uuid,
	"complete" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coverage_periods_range_check" CHECK (to_date >= from_date),
	CONSTRAINT "coverage_periods_source_check" CHECK (source IN ('import', 'provider_api', 'manual', 'statement', 'bootstrap'))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"key_version" text NOT NULL,
	"encrypted" boolean DEFAULT true NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"account_id" uuid,
	"entity_id" uuid,
	"source" text DEFAULT 'upload' NOT NULL,
	"note" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_sha256_key" UNIQUE("sha256"),
	CONSTRAINT "documents_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "documents_kind_check" CHECK (kind IN ('statement', 'agreement', 'valuation', 'tax', 'invoice', 'other')),
	CONSTRAINT "documents_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_size_check" CHECK (size_bytes >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"file_name" text NOT NULL,
	"file_kind" text,
	"file_sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"document_id" uuid,
	"account_id" uuid,
	"entity_id" uuid,
	"template_id" uuid,
	"connection_id" uuid,
	"parser" text,
	"parser_version" text,
	"mapping" jsonb,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detected_headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sample_rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{"total":0,"new":0,"duplicate":0,"possibleDuplicate":0,"pendingToPosted":0,"changedUpstream":0,"error":0,"skipped":0,"imported":0}'::jsonb NOT NULL,
	"coverage_from" date,
	"coverage_to" date,
	"statement_currency" text,
	"statement_opening" numeric(38, 18),
	"statement_closing" numeric(38, 18),
	"reconciliation" jsonb,
	"idempotency_key" text,
	"commit_idempotency_key" text,
	"job_id" uuid,
	"error" text,
	"provider_history_note" text,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"committed_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"reversal_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "import_batches_commit_idempotency_key_key" UNIQUE("commit_idempotency_key"),
	CONSTRAINT "import_batches_status_check" CHECK (status IN ('uploaded', 'parsing', 'needs_mapping', 'previewed', 'committing', 'committed', 'reversing', 'reversed', 'failed', 'cancelled')),
	CONSTRAINT "import_batches_file_kind_check" CHECK (file_kind IS NULL OR file_kind IN ('csv', 'xlsx', 'ofx', 'qfx', 'ibkr_flex_xml', 'ibkr_flex_csv', 'pdf')),
	CONSTRAINT "import_batches_reversal_check" CHECK (status <> 'reversed' OR (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"status" text NOT NULL,
	"raw" jsonb NOT NULL,
	"parsed" jsonb,
	"booked_on" date,
	"description" text,
	"amount" numeric(38, 18),
	"currency" text,
	"balance" numeric(38, 18),
	"pending" boolean DEFAULT false NOT NULL,
	"message" text,
	"dedupe_key" text,
	"duplicate_of_source_record_id" uuid,
	"source_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_batch_row_key" UNIQUE("batch_id","row_number"),
	CONSTRAINT "import_rows_status_check" CHECK (status IN ('new', 'duplicate', 'possible_duplicate', 'pending_to_posted', 'changed_upstream', 'error', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "import_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider_key" text,
	"file_kind" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"header_fingerprint" text,
	"verified" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_templates_name_key" UNIQUE("name"),
	CONSTRAINT "import_templates_file_kind_check" CHECK (file_kind IN ('csv', 'xlsx', 'ofx', 'qfx', 'ibkr_flex_xml', 'ibkr_flex_csv', 'pdf'))
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"currency" text NOT NULL,
	"opening_balance" numeric(38, 18),
	"movements" numeric(38, 18) NOT NULL,
	"expected_closing" numeric(38, 18),
	"actual_closing" numeric(38, 18),
	"difference" numeric(38, 18),
	"status" text NOT NULL,
	"batch_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliations_range_check" CHECK (period_end >= period_start),
	CONSTRAINT "reconciliations_status_check" CHECK (status IN ('balanced', 'discrepancy', 'incomplete')),
	CONSTRAINT "reconciliations_balanced_check" CHECK (status <> 'balanced' OR (difference IS NOT NULL AND difference = 0))
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"subject_label" text,
	"entity_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suggested_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'system' NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snoozed_until" timestamp with time zone,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exceptions_dedupe_key_key" UNIQUE("dedupe_key"),
	CONSTRAINT "exceptions_kind_check" CHECK (kind IN ('unclassified', 'ownership_uncertain', 'fee_policy_unconfirmed', 'reconciliation_discrepancy', 'reconciliation_question', 'missing_period', 'possible_duplicate', 'transfer_match_review', 'stale_connection', 'sync_error', 'valuation_unverified', 'restriction_unverified', 'interest_unverified', 'missing_information', 'tax_fact_unconfirmed', 'fx_rate_missing', 'import_error', 'unusual_transaction', 'agent_suggestion')),
	CONSTRAINT "exceptions_severity_check" CHECK (severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "exceptions_status_check" CHECK (status IN ('open', 'resolved', 'dismissed', 'snoozed')),
	CONSTRAINT "exceptions_snooze_check" CHECK (status <> 'snoozed' OR snoozed_until IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "connection_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_account_id" text NOT NULL,
	"external_name" text NOT NULL,
	"external_mask" text,
	"currency" text,
	"account_id" uuid,
	"excluded" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_accounts_external_key" UNIQUE("connection_id","external_account_id"),
	CONSTRAINT "connection_accounts_mask_check" CHECK (external_mask IS NULL OR length(regexp_replace(external_mask, '[^0-9]', '', 'g')) <= 4)
);
--> statement-breakpoint
CREATE TABLE "connection_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"ai_provider_id" uuid,
	"oauth_client_id" uuid,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_secrets_single_owner_check" CHECK (num_nonnulls(connection_id, ai_provider_id, oauth_client_id) = 1)
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_key" text NOT NULL,
	"method" text NOT NULL,
	"name" text NOT NULL,
	"entity_id" uuid,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"status_detail" text DEFAULT '' NOT NULL,
	"next_owner_step" text,
	"verification_level" text DEFAULT 'implemented' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"coverage_from" date,
	"coverage_to" date,
	"coverage_note" text,
	"schedule_enabled" boolean DEFAULT false NOT NULL,
	"schedule_cron" text,
	"schedule_timezone" text DEFAULT 'UTC' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_status_check" CHECK (status IN ('not_configured', 'needs_authorization', 'connected', 'syncing', 'partial_coverage', 'import_only', 'stale', 'rate_limited', 'error', 'paused', 'revoked')),
	CONSTRAINT "connections_verification_level_check" CHECK (verification_level IN ('implemented', 'sandbox_verified', 'live_verified'))
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_key" text NOT NULL,
	"client_id" text NOT NULL,
	"issuer" text,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"revocation_endpoint" text,
	"redirect_uri" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"registration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dynamic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_provider_client_key" UNIQUE("provider_key","client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"oauth_client_id" uuid,
	"code_verifier_ciphertext" text NOT NULL,
	"key_version" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"nonce_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_states_state_hash_key" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"oauth_client_id" uuid,
	"token_type" text DEFAULT 'bearer' NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"refresh_token_ciphertext" text,
	"key_version" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"refresh_expires_at" timestamp with time zone,
	"obtained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scheme" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"purpose" text NOT NULL,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_allowlist_target_key" UNIQUE("scheme","host","port"),
	CONSTRAINT "outbound_allowlist_scheme_check" CHECK (scheme IN ('https', 'http')),
	CONSTRAINT "outbound_allowlist_port_check" CHECK (port BETWEEN 1 AND 65535),
	CONSTRAINT "outbound_allowlist_host_check" CHECK (host = lower(host) AND host !~ '[/@*\s]')
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"job_id" uuid,
	"range_from" date,
	"range_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_runs_kind_check" CHECK (kind IN ('test', 'sync', 'backfill', 'import', 'discover')),
	CONSTRAINT "sync_runs_status_check" CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "job_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" numeric(5, 4),
	"progress_label" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"cancellable" boolean DEFAULT false NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"pgboss_job_id" text,
	"subject_type" text,
	"subject_id" text,
	"entity_id" uuid,
	"requested_by" text DEFAULT 'system' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_records_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "job_records_status_check" CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'cancelling', 'dead_letter', 'retrying')),
	CONSTRAINT "job_records_progress_check" CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1))
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"queues" text[] DEFAULT '{}'::text[] NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_beat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"planned" numeric(38, 18) NOT NULL,
	"rollover" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_lines_budget_category_key" UNIQUE("budget_id","category_id"),
	CONSTRAINT "budget_lines_kind_check" CHECK (kind IN ('spending', 'envelope', 'sinking_fund', 'fixed')),
	CONSTRAINT "budget_lines_planned_check" CHECK (planned >= 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"period_kind" text DEFAULT 'monthly' NOT NULL,
	"period_start" date,
	"period_end" date,
	"starts_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_period_kind_check" CHECK (period_kind IN ('monthly', 'weekly', 'custom')),
	CONSTRAINT "budgets_status_check" CHECK (status IN ('active', 'archived')),
	CONSTRAINT "budgets_period_check" CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);
--> statement-breakpoint
CREATE TABLE "goal_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"contributed_on" date NOT NULL,
	"status" text NOT NULL,
	"source_record_id" uuid,
	"note" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_contributions_status_check" CHECK (status IN ('planned', 'verified')),
	CONSTRAINT "goal_contributions_verified_evidence_check" CHECK (status <> 'verified' OR (source_record_id IS NOT NULL AND verified_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid,
	"target_amount" numeric(38, 18) NOT NULL,
	"target_currency" text NOT NULL,
	"target_date" date,
	"protected" boolean DEFAULT false NOT NULL,
	"held_in" text DEFAULT 'not_yet_funded' NOT NULL,
	"linked_account_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"travel" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_kind_check" CHECK (kind IN ('emergency_reserve', 'reserve', 'travel', 'sinking_fund', 'purchase', 'annual_bill', 'debt_payoff', 'other')),
	CONSTRAINT "goals_held_in_check" CHECK (held_in IN ('eligible_cash_accounts', 'separate_accounts', 'not_yet_funded')),
	CONSTRAINT "goals_status_check" CHECK (status IN ('active', 'paused', 'achieved', 'archived')),
	CONSTRAINT "goals_target_check" CHECK (target_amount > 0),
	CONSTRAINT "goals_priority_check" CHECK (priority BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"due_on" date NOT NULL,
	"amount" numeric(38, 18),
	"currency" text,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"recurring_item_id" uuid,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligations_kind_check" CHECK (kind IN ('bill', 'tax', 'purchase', 'loan', 'transfer', 'other')),
	CONSTRAINT "obligations_status_check" CHECK (status IN ('upcoming', 'paid', 'cancelled')),
	CONSTRAINT "obligations_amount_currency_check" CHECK (amount IS NULL OR currency IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "receivables_payables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"counterparty_name" text NOT NULL,
	"counterparty_id" uuid,
	"intercompany_entity_id" uuid,
	"reference" text,
	"amount" numeric(38, 18) NOT NULL,
	"currency" text NOT NULL,
	"outstanding" numeric(38, 18) NOT NULL,
	"issued_on" date,
	"due_on" date,
	"expected_on" date,
	"probability" numeric(38, 18) DEFAULT '1' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receivables_payables_kind_check" CHECK (kind IN ('receivable', 'payable')),
	CONSTRAINT "receivables_payables_status_check" CHECK (status IN ('open', 'partial', 'paid', 'written_off', 'cancelled')),
	CONSTRAINT "receivables_payables_source_check" CHECK (source IN ('manual', 'import')),
	CONSTRAINT "receivables_payables_category_check" CHECK (category IN ('sales', 'payroll', 'software', 'overhead', 'refund', 'tax', 'intercompany', 'owner', 'other')),
	CONSTRAINT "receivables_payables_probability_check" CHECK (probability >= 0 AND probability <= 1),
	CONSTRAINT "receivables_payables_intercompany_check" CHECK (intercompany_entity_id IS NULL OR intercompany_entity_id <> entity_id)
);
--> statement-breakpoint
CREATE TABLE "recurring_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"account_id" uuid,
	"counterparty_id" uuid,
	"counterparty_name" text,
	"kind" text NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric(38, 18),
	"currency" text,
	"amount_is_estimate" boolean DEFAULT false NOT NULL,
	"cadence" text DEFAULT 'unknown' NOT NULL,
	"day_of_month" integer,
	"next_due_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"detected" boolean DEFAULT false NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"internal_counterparty_entity_id" uuid,
	"last_seen_on" date,
	"detection" jsonb,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_items_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "recurring_items_kind_check" CHECK (kind IN ('bill', 'subscription', 'salary', 'income', 'transfer', 'loan_payment', 'payroll', 'overhead', 'software', 'insurance', 'annual_bill', 'intercompany_income', 'intercompany_expense', 'other')),
	CONSTRAINT "recurring_items_direction_check" CHECK (direction IN ('in', 'out')),
	CONSTRAINT "recurring_items_cadence_check" CHECK (cadence IN ('weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'irregular', 'unknown')),
	CONSTRAINT "recurring_items_status_check" CHECK (status IN ('active', 'paused', 'cancelled', 'suggested')),
	CONSTRAINT "recurring_items_day_check" CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
	CONSTRAINT "recurring_items_amount_currency_check" CHECK (amount IS NULL OR currency IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "reward_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"terms_as_of" date NOT NULL,
	"source_url" text,
	"eligibility" text,
	"annual_fee" numeric(38, 18),
	"annual_fee_currency" text,
	"earn_rate" numeric(38, 18),
	"earn_unit" text NOT NULL,
	"point_value" numeric(38, 18),
	"point_value_currency" text,
	"fx_fee_percent" numeric(38, 18),
	"payment_fee_percent" numeric(38, 18),
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_products_earn_unit_check" CHECK (earn_unit IN ('cashback_percent', 'points_per_currency_unit'))
);
--> statement-breakpoint
CREATE TABLE "scenario_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scenario_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenario_versions_scenario_version_key" UNIQUE("scenario_id","version"),
	CONSTRAINT "scenario_versions_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction" text NOT NULL,
	"topic" text NOT NULL,
	"status" text DEFAULT 'unconfirmed' NOT NULL,
	"value" text,
	"deadline" text,
	"accountant_question" text,
	"document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"bootstrap_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_facts_bootstrap_key_key" UNIQUE("bootstrap_key"),
	CONSTRAINT "tax_facts_topic_check" CHECK (topic IN ('residency', 'filing_status', 'deadline', 'registration', 'third_party_funds', 'document', 'other')),
	CONSTRAINT "tax_facts_status_check" CHECK (status IN ('unconfirmed', 'confirmed', 'needs_accountant'))
);
--> statement-breakpoint
CREATE TABLE "travel_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text DEFAULT 'default' NOT NULL,
	"home_airports" text[] DEFAULT '{}'::text[] NOT NULL,
	"preferred_airlines" text[] DEFAULT '{}'::text[] NOT NULL,
	"cabin_class" text,
	"loyalty_programs" text[] DEFAULT '{}'::text[] NOT NULL,
	"route_preferences" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievements_dedupe_key_key" UNIQUE("dedupe_key"),
	CONSTRAINT "achievements_kind_check" CHECK (kind IN ('review_completed', 'reconciled_account', 'goal_contribution_verified', 'verified_saving', 'exceptions_cleared', 'streak')),
	CONSTRAINT "achievements_evidence_check" CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) > 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"why" text NOT NULL,
	"href" text,
	"dedupe_key" text NOT NULL,
	"delivered_channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_key" UNIQUE("dedupe_key"),
	CONSTRAINT "notifications_severity_check" CHECK (severity IN ('info', 'warning', 'critical')),
	CONSTRAINT "notifications_href_check" CHECK (href IS NULL OR href ~ '^/[^/]')
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"generated_by" text DEFAULT 'deterministic' NOT NULL,
	"what_changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"why_it_matters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_action" jsonb,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_kind_period_key" UNIQUE("kind","period_start"),
	CONSTRAINT "reviews_kind_check" CHECK (kind IN ('weekly', 'monthly')),
	CONSTRAINT "reviews_status_check" CHECK (status IN ('draft', 'in_progress', 'completed')),
	CONSTRAINT "reviews_completed_check" CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"queue" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "execution_mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker_key" text NOT NULL,
	"status" text DEFAULT 'disabled' NOT NULL,
	"reason" text NOT NULL,
	"requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_mandates_disabled_check" CHECK (status = 'disabled')
);
--> statement-breakpoint
CREATE TABLE "paper_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"filled_at" timestamp with time zone NOT NULL,
	"price_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_fills_proposal_key" UNIQUE("proposal_id"),
	CONSTRAINT "paper_fills_price_check" CHECK (price >= 0)
);
--> statement-breakpoint
CREATE TABLE "risk_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"max_position_share" numeric(38, 18) NOT NULL,
	"max_single_order_value_usd" numeric(38, 18) NOT NULL,
	"allowed_instrument_kinds" text[] NOT NULL,
	"leverage_allowed" boolean DEFAULT false NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_by" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_policies_version_key" UNIQUE("version"),
	CONSTRAINT "risk_policies_no_leverage_check" CHECK (leverage_allowed = false),
	CONSTRAINT "risk_policies_share_check" CHECK (max_position_share > 0 AND max_position_share <= 1)
);
--> statement-breakpoint
CREATE TABLE "trade_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" text DEFAULT 'paper' NOT NULL,
	"instrument" text NOT NULL,
	"instrument_id" uuid,
	"side" text NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"limit_price" numeric(38, 18),
	"currency" text NOT NULL,
	"rationale" text NOT NULL,
	"created_by" text NOT NULL,
	"agent_client_id" uuid,
	"risk_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_proposals_paper_only_check" CHECK (mode = 'paper'),
	CONSTRAINT "trade_proposals_side_check" CHECK (side IN ('buy', 'sell')),
	CONSTRAINT "trade_proposals_created_by_check" CHECK (created_by IN ('owner', 'agent')),
	CONSTRAINT "trade_proposals_status_check" CHECK (status IN ('draft', 'simulated', 'paper_filled', 'rejected', 'expired')),
	CONSTRAINT "trade_proposals_quantity_check" CHECK (quantity > 0)
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"locality" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"allow_identifiable_data" boolean DEFAULT false NOT NULL,
	"monthly_budget_usd" numeric(38, 18),
	"task_routing" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_orchestrator" boolean DEFAULT false NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_providers_kind_check" CHECK (kind IN ('openai_compatible', 'anthropic')),
	CONSTRAINT "ai_providers_locality_check" CHECK (locality IN ('local', 'cloud'))
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(38, 18),
	"status" text DEFAULT 'ok' NOT NULL,
	"request_id" text,
	"job_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_status_check" CHECK (status IN ('ok', 'error', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "coach_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"generated_by" text NOT NULL,
	"provider_id" uuid,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_messages_role_check" CHECK (role IN ('owner', 'coach')),
	CONSTRAINT "coach_messages_status_check" CHECK (status IN ('complete', 'streaming', 'cancelled', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "coach_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"size_bytes" bigint,
	"sha256" text,
	"key_version" text,
	"destination" text DEFAULT 'local' NOT NULL,
	"includes" text[] DEFAULT '{}'::text[] NOT NULL,
	"artifact_name" text,
	"restore_verified_at" timestamp with time zone,
	"restore_verification" text,
	"error" text,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backups_status_check" CHECK (status IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "backups_destination_check" CHECK (destination IN ('local', 'offhost')),
	CONSTRAINT "backups_artifact_name_check" CHECK (artifact_name IS NULL OR artifact_name !~ '(^/|\.\.)')
);
--> statement-breakpoint
CREATE TABLE "bootstrap_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bootstrap_id" text NOT NULL,
	"format_version" integer NOT NULL,
	"file_sha256" text NOT NULL,
	"counts" jsonb NOT NULL,
	"applied_by" text DEFAULT 'bootstrap-cli' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bootstrap_runs_bootstrap_id_key" UNIQUE("bootstrap_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text DEFAULT 'system',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_base_currencies_code_fk" FOREIGN KEY ("base") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_quote_currencies_code_fk" FOREIGN KEY ("quote") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_base_currency_currencies_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_interests" ADD CONSTRAINT "ownership_interests_holder_entity_id_entities_id_fk" FOREIGN KEY ("holder_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_interests" ADD CONSTRAINT "ownership_interests_held_entity_id_entities_id_fk" FOREIGN KEY ("held_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_ownership_rules" ADD CONSTRAINT "account_ownership_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_ownership_rules" ADD CONSTRAINT "account_ownership_rules_economic_owner_entity_id_entities_id_fk" FOREIGN KEY ("economic_owner_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_legal_entity_id_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_economic_owner_entity_id_entities_id_fk" FOREIGN KEY ("economic_owner_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_superseded_by_balance_snapshots_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."balance_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_income_terms" ADD CONSTRAINT "fixed_income_terms_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_income_terms" ADD CONSTRAINT "fixed_income_terms_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_income_terms" ADD CONSTRAINT "fixed_income_terms_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_lines" ADD CONSTRAINT "holding_lines_snapshot_id_holdings_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."holdings_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_lines" ADD CONSTRAINT "holding_lines_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings_snapshots" ADD CONSTRAINT "holdings_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings_snapshots" ADD CONSTRAINT "holdings_snapshots_superseded_by_holdings_snapshots_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."holdings_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings_snapshots" ADD CONSTRAINT "holdings_snapshots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings_snapshots" ADD CONSTRAINT "holdings_snapshots_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings_snapshots" ADD CONSTRAINT "holdings_snapshots_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_transactions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_transactions" ADD CONSTRAINT "investment_transactions_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability_terms" ADD CONSTRAINT "liability_terms_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability_terms" ADD CONSTRAINT "liability_terms_lender_counterparty_id_counterparties_id_fk" FOREIGN KEY ("lender_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability_terms" ADD CONSTRAINT "liability_terms_secured_by_account_id_accounts_id_fk" FOREIGN KEY ("secured_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_details" ADD CONSTRAINT "property_details_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_details" ADD CONSTRAINT "property_details_mortgage_account_id_accounts_id_fk" FOREIGN KEY ("mortgage_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restrictions" ADD CONSTRAINT "restrictions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restrictions" ADD CONSTRAINT "restrictions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restrictions" ADD CONSTRAINT "restrictions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_journal_entries_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_by_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversed_by_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_economic_owner_entity_id_entities_id_fk" FOREIGN KEY ("economic_owner_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_counterparty_entity_id_entities_id_fk" FOREIGN KEY ("counterparty_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_arrangement_id_third_party_arrangements_id_fk" FOREIGN KEY ("arrangement_id") REFERENCES "public"."third_party_arrangements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_economic_owner_entity_id_entities_id_fk" FOREIGN KEY ("economic_owner_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_transfer_match_id_transfer_matches_id_fk" FOREIGN KEY ("transfer_match_id") REFERENCES "public"."transfer_matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_tags" ADD CONSTRAINT "source_record_tags_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_record_tags" ADD CONSTRAINT "source_record_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_superseded_by_source_records_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_arrangements" ADD CONSTRAINT "third_party_arrangements_third_party_entity_id_entities_id_fk" FOREIGN KEY ("third_party_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_arrangements" ADD CONSTRAINT "third_party_arrangements_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_arrangements" ADD CONSTRAINT "third_party_arrangements_fee_recipient_entity_id_entities_id_fk" FOREIGN KEY ("fee_recipient_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_matches" ADD CONSTRAINT "transfer_matches_from_source_record_id_source_records_id_fk" FOREIGN KEY ("from_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_matches" ADD CONSTRAINT "transfer_matches_to_source_record_id_source_records_id_fk" FOREIGN KEY ("to_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_periods" ADD CONSTRAINT "coverage_periods_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_periods" ADD CONSTRAINT "coverage_periods_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_periods" ADD CONSTRAINT "coverage_periods_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_template_id_import_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."import_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_duplicate_of_source_record_id_source_records_id_fk" FOREIGN KEY ("duplicate_of_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_accounts" ADD CONSTRAINT "connection_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_accounts" ADD CONSTRAINT "connection_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_secrets" ADD CONSTRAINT "connection_secrets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_secrets" ADD CONSTRAINT "connection_secrets_ai_provider_id_ai_providers_id_fk" FOREIGN KEY ("ai_provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_secrets" ADD CONSTRAINT "connection_secrets_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_records" ADD CONSTRAINT "job_records_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_recurring_item_id_recurring_items_id_fk" FOREIGN KEY ("recurring_item_id") REFERENCES "public"."recurring_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables_payables" ADD CONSTRAINT "receivables_payables_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables_payables" ADD CONSTRAINT "receivables_payables_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables_payables" ADD CONSTRAINT "receivables_payables_intercompany_entity_id_entities_id_fk" FOREIGN KEY ("intercompany_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables_payables" ADD CONSTRAINT "receivables_payables_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_internal_counterparty_entity_id_entities_id_fk" FOREIGN KEY ("internal_counterparty_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_versions" ADD CONSTRAINT "scenario_versions_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_proposal_id_trade_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."trade_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_proposals" ADD CONSTRAINT "trade_proposals_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_proposals" ADD CONSTRAINT "trade_proposals_agent_client_id_agent_clients_id_fk" FOREIGN KEY ("agent_client_id") REFERENCES "public"."agent_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_thread_id_coach_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."coach_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_object_idx" ON "audit_events" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "device_pairings_user_code_idx" ON "device_pairings" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX "device_pairings_installation_idx" ON "device_pairings" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "devices_installation_idx" ON "devices" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "launch_requests_expires_idx" ON "launch_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_account_singleton" ON "owner_account" USING btree ((true));--> statement-breakpoint
CREATE INDEX "recovery_codes_batch_idx" ON "recovery_codes" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "sessions_absolute_expires_idx" ON "sessions" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_challenges_challenge_key" ON "webauthn_challenges" USING btree ("challenge");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_idx" ON "webauthn_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "fx_rates_lookup_idx" ON "fx_rates" USING btree ("base","quote","as_of");--> statement-breakpoint
CREATE INDEX "prices_lookup_idx" ON "prices" USING btree ("instrument_id","as_of");--> statement-breakpoint
CREATE INDEX "counterparties_normalized_name_idx" ON "counterparties" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_single_primary_owner" ON "entities" USING btree ("primary_owner") WHERE primary_owner;--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_isin_key" ON "instruments" USING btree ("isin") WHERE isin IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ownership_interests_held_idx" ON "ownership_interests" USING btree ("held_entity_id");--> statement-breakpoint
CREATE INDEX "account_ownership_rules_account_idx" ON "account_ownership_rules" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "accounts_legal_entity_idx" ON "accounts" USING btree ("legal_entity_id");--> statement-breakpoint
CREATE INDEX "accounts_economic_owner_idx" ON "accounts" USING btree ("economic_owner_entity_id");--> statement-breakpoint
CREATE INDEX "accounts_connection_idx" ON "accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "balance_snapshots_account_idx" ON "balance_snapshots" USING btree ("account_id","reported_at");--> statement-breakpoint
CREATE INDEX "holding_lines_snapshot_idx" ON "holding_lines" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "holdings_snapshots_account_idx" ON "holdings_snapshots" USING btree ("account_id","reported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_transactions_external_key" ON "investment_transactions" USING btree ("account_id","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "investment_transactions_account_idx" ON "investment_transactions" USING btree ("account_id","trade_date");--> statement-breakpoint
CREATE INDEX "restrictions_account_idx" ON "restrictions" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reverses_key" ON "journal_entries" USING btree ("reverses_entry_id") WHERE reverses_entry_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "journal_entries_entity_date_idx" ON "journal_entries" USING btree ("entity_id","entry_date");--> statement-breakpoint
CREATE INDEX "journal_entries_source_record_idx" ON "journal_entries" USING btree ("source_record_id");--> statement-breakpoint
CREATE INDEX "journal_entries_import_batch_idx" ON "journal_entries" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "journal_lines_ledger_account_idx" ON "journal_lines" USING btree ("ledger_account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "ledger_accounts_account_idx" ON "ledger_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "classifications_one_current" ON "classifications" USING btree ("source_record_id") WHERE is_current;--> statement-breakpoint
CREATE INDEX "classifications_category_idx" ON "classifications" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "rules_active_priority_idx" ON "rules" USING btree ("active","priority");--> statement-breakpoint
CREATE INDEX "source_records_account_booked_idx" ON "source_records" USING btree ("account_id","booked_on");--> statement-breakpoint
CREATE INDEX "source_records_provider_idx" ON "source_records" USING btree ("account_id","provider_id");--> statement-breakpoint
CREATE INDEX "source_records_batch_idx" ON "source_records" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "source_records_content_hash_idx" ON "source_records" USING btree ("account_id","content_hash");--> statement-breakpoint
CREATE INDEX "transfer_matches_to_idx" ON "transfer_matches" USING btree ("to_source_record_id");--> statement-breakpoint
CREATE INDEX "coverage_periods_account_idx" ON "coverage_periods" USING btree ("account_id","from_date");--> statement-breakpoint
CREATE INDEX "documents_account_idx" ON "documents" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "import_batches_sha_idx" ON "import_batches" USING btree ("file_sha256");--> statement-breakpoint
CREATE INDEX "import_batches_account_idx" ON "import_batches" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "import_rows_batch_status_idx" ON "import_rows" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "import_templates_fingerprint_idx" ON "import_templates" USING btree ("header_fingerprint");--> statement-breakpoint
CREATE INDEX "reconciliations_account_idx" ON "reconciliations" USING btree ("account_id","period_end");--> statement-breakpoint
CREATE INDEX "exceptions_status_kind_idx" ON "exceptions" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "exceptions_subject_idx" ON "exceptions" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_secrets_connection_name_key" ON "connection_secrets" USING btree ("connection_id","name") WHERE connection_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_secrets_ai_provider_name_key" ON "connection_secrets" USING btree ("ai_provider_id","name") WHERE ai_provider_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_secrets_oauth_client_name_key" ON "connection_secrets" USING btree ("oauth_client_id","name") WHERE oauth_client_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "connection_secrets_key_version_idx" ON "connection_secrets" USING btree ("key_version");--> statement-breakpoint
CREATE INDEX "connections_provider_idx" ON "connections" USING btree ("provider_key");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_one_active" ON "oauth_tokens" USING btree ("connection_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "sync_runs_connection_idx" ON "sync_runs" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "job_records_status_idx" ON "job_records" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "job_records_subject_idx" ON "job_records" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "job_records_pgboss_idx" ON "job_records" USING btree ("pgboss_job_id");--> statement-breakpoint
CREATE INDEX "budgets_entity_idx" ON "budgets" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "goal_contributions_goal_idx" ON "goal_contributions" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "obligations_entity_due_idx" ON "obligations" USING btree ("entity_id","due_on");--> statement-breakpoint
CREATE INDEX "receivables_payables_entity_idx" ON "receivables_payables" USING btree ("entity_id","status");--> statement-breakpoint
CREATE INDEX "recurring_items_entity_idx" ON "recurring_items" USING btree ("entity_id","status");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_policies_one_current" ON "risk_policies" USING btree ("is_current") WHERE is_current;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_providers_one_orchestrator" ON "ai_providers" USING btree ("is_orchestrator") WHERE is_orchestrator;--> statement-breakpoint
CREATE INDEX "ai_usage_provider_time_idx" ON "ai_usage" USING btree ("provider_id","occurred_at");--> statement-breakpoint
CREATE INDEX "coach_messages_thread_idx" ON "coach_messages" USING btree ("thread_id","created_at");