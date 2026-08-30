-- CreateTable
CREATE TABLE "provider_health" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_id" TEXT NOT NULL,
    "country_iso2" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLOSED',
    "successes" INTEGER NOT NULL DEFAULT 0,
    "technical_failures" INTEGER NOT NULL DEFAULT 0,
    "declines" INTEGER NOT NULL DEFAULT 0,
    "latency_p95_ms" INTEGER,
    "opened_at" DATETIME,
    "next_probe_at" DATETIME,
    "last_failure_code" TEXT,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "routing_decisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "attempt_id" TEXT,
    "country_iso2" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "chosen_provider_id" TEXT NOT NULL,
    "candidates" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "provider_health_state_idx" ON "provider_health"("state");

-- CreateIndex
CREATE INDEX "provider_health_provider_id_idx" ON "provider_health"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "routing_decisions_attempt_id_key" ON "routing_decisions"("attempt_id");

-- CreateIndex
CREATE INDEX "routing_decisions_merchant_id_created_at_idx" ON "routing_decisions"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "routing_decisions_ref_type_ref_id_idx" ON "routing_decisions"("ref_type", "ref_id");
