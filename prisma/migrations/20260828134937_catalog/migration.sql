-- CreateTable
CREATE TABLE "currencies" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "exponent" INTEGER NOT NULL,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "countries" (
    "iso2" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL,
    "calling_code" TEXT NOT NULL,
    "zones" TEXT NOT NULL DEFAULT '',
    "sovereign" BOOLEAN NOT NULL DEFAULT true,
    "kyc_requirement" TEXT NOT NULL,
    "kyc_label" TEXT NOT NULL,
    "allows_individual" BOOLEAN NOT NULL DEFAULT false,
    "fee_min_bps" INTEGER NOT NULL,
    "fee_max_bps" INTEGER NOT NULL,
    "payout_mode" TEXT NOT NULL,
    "payout_note" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "countries_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "integration" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "coverage_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "country_iso2" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "channels" TEXT NOT NULL,
    "supports_payin" BOOLEAN NOT NULL DEFAULT true,
    "supports_payout" BOOLEAN NOT NULL DEFAULT true,
    "networks" TEXT NOT NULL DEFAULT '',
    "fee_min_bps" INTEGER,
    "fee_max_bps" INTEGER,
    "priority" INTEGER NOT NULL,
    "note" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "coverage_rules_country_iso2_fkey" FOREIGN KEY ("country_iso2") REFERENCES "countries" ("iso2") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "coverage_rules_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "countries_region_idx" ON "countries"("region");

-- CreateIndex
CREATE INDEX "countries_enabled_idx" ON "countries"("enabled");

-- CreateIndex
CREATE INDEX "providers_integration_idx" ON "providers"("integration");

-- CreateIndex
CREATE INDEX "coverage_rules_country_iso2_enabled_idx" ON "coverage_rules"("country_iso2", "enabled");

-- CreateIndex
CREATE INDEX "coverage_rules_provider_id_idx" ON "coverage_rules"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "coverage_rules_country_iso2_provider_id_key" ON "coverage_rules"("country_iso2", "provider_id");
