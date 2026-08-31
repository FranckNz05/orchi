-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient_phone" TEXT,
    "recipient_network" TEXT,
    "recipient_account_number" TEXT,
    "recipient_bank_code" TEXT,
    "recipient_name" TEXT,
    "share_bps" INTEGER NOT NULL,
    "share_base" TEXT NOT NULL DEFAULT 'net',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "partners_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "partner_accruals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partner_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "base_amount" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "share_bps" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "settlement_id" TEXT,
    "due_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_accruals_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "partner_accruals_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "partner_settlements" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "partner_settlements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "partner_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "accrual_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payout_id" TEXT,
    "failure_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "partner_settlements_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "partners_merchant_id_environment_status_idx" ON "partners"("merchant_id", "environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partners_merchant_id_reference_environment_key" ON "partners"("merchant_id", "reference", "environment");

-- CreateIndex
CREATE INDEX "partner_accruals_status_due_at_idx" ON "partner_accruals"("status", "due_at");

-- CreateIndex
CREATE INDEX "partner_accruals_merchant_id_status_idx" ON "partner_accruals"("merchant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_accruals_partner_id_payment_id_key" ON "partner_accruals"("partner_id", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_settlements_payout_id_key" ON "partner_settlements"("payout_id");

-- CreateIndex
CREATE INDEX "partner_settlements_merchant_id_status_idx" ON "partner_settlements"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "partner_settlements_status_created_at_idx" ON "partner_settlements"("status", "created_at");
