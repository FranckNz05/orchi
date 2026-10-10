-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_merchant_settlements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "provider_fee_amount" INTEGER NOT NULL DEFAULT 0,
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
INSERT INTO "new_merchant_settlements" ("actor_email", "actor_id", "amount", "cancel_reason", "cancelled_at", "cancelled_by", "checked_at", "created_at", "currency", "destination", "environment", "external_reference", "failure_reason", "id", "merchant_id", "method", "mode", "network", "note", "provider_reference", "source_provider_id", "status") SELECT "actor_email", "actor_id", "amount", "cancel_reason", "cancelled_at", "cancelled_by", "checked_at", "created_at", "currency", "destination", "environment", "external_reference", "failure_reason", "id", "merchant_id", "method", "mode", "network", "note", "provider_reference", "source_provider_id", "status" FROM "merchant_settlements";
DROP TABLE "merchant_settlements";
ALTER TABLE "new_merchant_settlements" RENAME TO "merchant_settlements";
CREATE INDEX "merchant_settlements_merchant_id_created_at_idx" ON "merchant_settlements"("merchant_id", "created_at");
CREATE INDEX "merchant_settlements_status_idx" ON "merchant_settlements"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

