-- CreateTable
CREATE TABLE "provider_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "credentials" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "last_used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "provider_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" TEXT,
    "resource_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "network" TEXT,
    "customer_phone" TEXT,
    "customer_email" TEXT,
    "customer_name" TEXT,
    "description" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "return_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "current_attempt_id" TEXT,
    "provider_fee_amount" INTEGER,
    "platform_fee_amount" INTEGER,
    "succeeded_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "payments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payment_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "provider_id" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider_reference" TEXT,
    "provider_code" TEXT,
    "provider_message" TEXT,
    "failure_code" TEXT,
    "action_type" TEXT,
    "action_url" TEXT,
    "action_instructions" TEXT,
    "action_expires_at" DATETIME,
    "provider_fee_amount" INTEGER,
    "raw_response" TEXT,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "payment_attempts_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient_phone" TEXT,
    "recipient_network" TEXT,
    "recipient_account_number" TEXT,
    "recipient_bank_code" TEXT,
    "recipient_name" TEXT,
    "description" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "current_attempt_id" TEXT,
    "provider_fee_amount" INTEGER,
    "platform_fee_amount" INTEGER,
    "settled_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "payouts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "payout_attempts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payout_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "provider_id" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider_reference" TEXT,
    "provider_code" TEXT,
    "provider_message" TEXT,
    "failure_code" TEXT,
    "provider_fee_amount" INTEGER,
    "raw_response" TEXT,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "payout_attempts_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "payout_attempts_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ledger_journals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journal_id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_entries_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "ledger_journals" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "provider_accounts_merchant_id_status_idx" ON "provider_accounts"("merchant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "provider_accounts_merchant_id_provider_id_environment_key" ON "provider_accounts"("merchant_id", "provider_id", "environment");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_merchant_id_key_key" ON "idempotency_records"("merchant_id", "key");

-- CreateIndex
CREATE INDEX "payments_merchant_id_status_idx" ON "payments"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_merchant_id_reference_key" ON "payments"("merchant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_reference_key" ON "payment_attempts"("reference");

-- CreateIndex
CREATE INDEX "payment_attempts_status_updated_at_idx" ON "payment_attempts"("status", "updated_at");

-- CreateIndex
CREATE INDEX "payment_attempts_provider_reference_idx" ON "payment_attempts"("provider_reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_payment_id_attempt_number_key" ON "payment_attempts"("payment_id", "attempt_number");

-- CreateIndex
CREATE INDEX "payouts_merchant_id_status_idx" ON "payouts"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "payouts_status_created_at_idx" ON "payouts"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_merchant_id_reference_key" ON "payouts"("merchant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "payout_attempts_reference_key" ON "payout_attempts"("reference");

-- CreateIndex
CREATE INDEX "payout_attempts_status_updated_at_idx" ON "payout_attempts"("status", "updated_at");

-- CreateIndex
CREATE INDEX "payout_attempts_provider_reference_idx" ON "payout_attempts"("provider_reference");

-- CreateIndex
CREATE UNIQUE INDEX "payout_attempts_payout_id_attempt_number_key" ON "payout_attempts"("payout_id", "attempt_number");

-- CreateIndex
CREATE INDEX "ledger_journals_merchant_id_created_at_idx" ON "ledger_journals"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_journals_ref_type_ref_id_idx" ON "ledger_journals"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "ledger_entries_account_created_at_idx" ON "ledger_entries"("account", "created_at");
