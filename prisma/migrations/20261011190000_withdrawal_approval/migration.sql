-- AlterTable
ALTER TABLE "merchant_settlements" ADD COLUMN "approval_reason" TEXT;
ALTER TABLE "merchant_settlements" ADD COLUMN "beneficiary_name" TEXT;
ALTER TABLE "merchant_settlements" ADD COLUMN "country" TEXT;
ALTER TABLE "merchant_settlements" ADD COLUMN "decided_at" DATETIME;
ALTER TABLE "merchant_settlements" ADD COLUMN "decided_by" TEXT;
ALTER TABLE "merchant_settlements" ADD COLUMN "decision_note" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "withdrawal_pin_hash" TEXT,
    "pin_failed_count" INTEGER NOT NULL DEFAULT 0,
    "pin_locked_until" DATETIME,
    "last_login_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "users_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_users" ("created_at", "email", "id", "last_login_at", "merchant_id", "name", "password_hash", "platform_admin", "role", "status", "updated_at") SELECT "created_at", "email", "id", "last_login_at", "merchant_id", "name", "password_hash", "platform_admin", "role", "status", "updated_at" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_merchant_id_idx" ON "users"("merchant_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

