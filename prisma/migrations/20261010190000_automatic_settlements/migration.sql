-- CreateTable
CREATE TABLE "merchant_settlement_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "beneficiary_name" TEXT NOT NULL,
    "auto_enabled" BOOLEAN NOT NULL DEFAULT false,
    "min_amount" INTEGER NOT NULL DEFAULT 5000,
    "updated_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "merchant_settlement_targets_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_merchant_settlements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source_provider_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "external_reference" TEXT,
    "note" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "network" TEXT,
    "provider_reference" TEXT,
    "failure_reason" TEXT,
    "checked_at" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PAID',
    "actor_id" TEXT NOT NULL,
    "actor_email" TEXT NOT NULL,
    "cancelled_at" DATETIME,
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchant_settlements_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_merchant_settlements" ("actor_email", "actor_id", "amount", "cancel_reason", "cancelled_at", "cancelled_by", "created_at", "currency", "destination", "environment", "external_reference", "id", "merchant_id", "method", "note", "source_provider_id", "status") SELECT "actor_email", "actor_id", "amount", "cancel_reason", "cancelled_at", "cancelled_by", "created_at", "currency", "destination", "environment", "external_reference", "id", "merchant_id", "method", "note", "source_provider_id", "status" FROM "merchant_settlements";
DROP TABLE "merchant_settlements";
ALTER TABLE "new_merchant_settlements" RENAME TO "merchant_settlements";
CREATE INDEX "merchant_settlements_merchant_id_created_at_idx" ON "merchant_settlements"("merchant_id", "created_at");
CREATE INDEX "merchant_settlements_status_idx" ON "merchant_settlements"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "merchant_settlement_targets_merchant_id_environment_provider_id_key" ON "merchant_settlement_targets"("merchant_id", "environment", "provider_id");

