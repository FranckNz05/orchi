-- CreateTable
CREATE TABLE "merchant_settlements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "source_provider_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "external_reference" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PAID',
    "actor_id" TEXT NOT NULL,
    "actor_email" TEXT NOT NULL,
    "cancelled_at" DATETIME,
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchant_settlements_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "merchant_settlements_merchant_id_created_at_idx" ON "merchant_settlements"("merchant_id", "created_at");
