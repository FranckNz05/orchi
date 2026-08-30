-- AlterTable
ALTER TABLE "payment_attempts" ADD COLUMN "provider_fee_bps" INTEGER;

-- AlterTable
ALTER TABLE "payout_attempts" ADD COLUMN "provider_fee_bps" INTEGER;
