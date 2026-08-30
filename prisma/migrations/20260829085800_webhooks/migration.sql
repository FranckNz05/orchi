-- Ajout de webhook_token sur provider_accounts.
--
-- La colonne est NOT NULL UNIQUE : la copie de table ci-dessous remplit les
-- lignes existantes avec un jeton aleatoire (hex(randomblob(16))), au lieu de
-- vider la table. Aucun compte agregateur deja connecte n'est perdu ; les
-- marchands concernes devront simplement communiquer la nouvelle URL de
-- callback a leur agregateur.
-- CreateTable
CREATE TABLE "inbound_webhooks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_id" TEXT NOT NULL,
    "provider_account_id" TEXT,
    "merchant_id" TEXT,
    "event_id" TEXT NOT NULL,
    "raw_body" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "reject_reason" TEXT,
    "provider_reference" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'unknown',
    "status" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'RECEIVED',
    "applied_to_attempt_id" TEXT,
    "note" TEXT,
    "processed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT NOT NULL DEFAULT '*',
    "environment" TEXT NOT NULL DEFAULT 'test',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "webhook_endpoints_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "outbound_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "next_attempt_at" DATETIME NOT NULL,
    "delivered_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "outbound_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_provider_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "webhook_token" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "last_used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "provider_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_provider_accounts" ("created_at", "credentials", "environment", "id", "last_used_at", "merchant_id", "priority", "provider_id", "status", "updated_at", "webhook_token") SELECT "created_at", "credentials", "environment", "id", "last_used_at", "merchant_id", "priority", "provider_id", "status", "updated_at", lower(hex(randomblob(16))) FROM "provider_accounts";
DROP TABLE "provider_accounts";
ALTER TABLE "new_provider_accounts" RENAME TO "provider_accounts";
CREATE UNIQUE INDEX "provider_accounts_webhook_token_key" ON "provider_accounts"("webhook_token");
CREATE INDEX "provider_accounts_merchant_id_status_idx" ON "provider_accounts"("merchant_id", "status");
CREATE UNIQUE INDEX "provider_accounts_merchant_id_provider_id_environment_key" ON "provider_accounts"("merchant_id", "provider_id", "environment");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "inbound_webhooks_created_at_idx" ON "inbound_webhooks"("created_at");

-- CreateIndex
CREATE INDEX "inbound_webhooks_outcome_idx" ON "inbound_webhooks"("outcome");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_webhooks_provider_id_event_id_key" ON "inbound_webhooks"("provider_id", "event_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_merchant_id_status_idx" ON "webhook_endpoints"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "outbound_deliveries_status_next_attempt_at_idx" ON "outbound_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_deliveries_endpoint_id_event_id_key" ON "outbound_deliveries"("endpoint_id", "event_id");
