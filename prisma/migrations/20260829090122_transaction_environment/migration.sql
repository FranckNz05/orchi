-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'test',
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
INSERT INTO "new_payments" ("amount", "channel", "country", "created_at", "currency", "current_attempt_id", "customer_email", "customer_name", "customer_phone", "description", "id", "merchant_id", "metadata", "network", "platform_fee_amount", "provider_fee_amount", "reference", "return_url", "status", "succeeded_at", "updated_at") SELECT "amount", "channel", "country", "created_at", "currency", "current_attempt_id", "customer_email", "customer_name", "customer_phone", "description", "id", "merchant_id", "metadata", "network", "platform_fee_amount", "provider_fee_amount", "reference", "return_url", "status", "succeeded_at", "updated_at" FROM "payments";
DROP TABLE "payments";
ALTER TABLE "new_payments" RENAME TO "payments";
CREATE INDEX "payments_merchant_id_status_idx" ON "payments"("merchant_id", "status");
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");
CREATE UNIQUE INDEX "payments_merchant_id_reference_key" ON "payments"("merchant_id", "reference");
CREATE TABLE "new_payouts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'test',
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
INSERT INTO "new_payouts" ("amount", "channel", "country", "created_at", "currency", "current_attempt_id", "description", "id", "merchant_id", "metadata", "platform_fee_amount", "provider_fee_amount", "recipient_account_number", "recipient_bank_code", "recipient_name", "recipient_network", "recipient_phone", "reference", "settled_at", "status", "updated_at") SELECT "amount", "channel", "country", "created_at", "currency", "current_attempt_id", "description", "id", "merchant_id", "metadata", "platform_fee_amount", "provider_fee_amount", "recipient_account_number", "recipient_bank_code", "recipient_name", "recipient_network", "recipient_phone", "reference", "settled_at", "status", "updated_at" FROM "payouts";
DROP TABLE "payouts";
ALTER TABLE "new_payouts" RENAME TO "payouts";
CREATE INDEX "payouts_merchant_id_status_idx" ON "payouts"("merchant_id", "status");
CREATE INDEX "payouts_status_created_at_idx" ON "payouts"("status", "created_at");
CREATE UNIQUE INDEX "payouts_merchant_id_reference_key" ON "payouts"("merchant_id", "reference");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
