-- CreateTable
CREATE TABLE "checkout_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'test',
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "description" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "customer_name" TEXT,
    "customer_email" TEXT,
    "customer_phone" TEXT,
    "success_url" TEXT,
    "cancel_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "payment_id" TEXT,
    "expires_at" DATETIME NOT NULL,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "checkout_sessions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_token_key" ON "checkout_sessions"("token");

-- CreateIndex
CREATE INDEX "checkout_sessions_status_expires_at_idx" ON "checkout_sessions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_merchant_id_reference_key" ON "checkout_sessions"("merchant_id", "reference");
