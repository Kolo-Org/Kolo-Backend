-- Add hash column for searchable encryption of phone numbers, and widen the
-- phone number column to hold the AES-256-GCM JSON blob. Both are nullable
-- until the backfill script has encrypted every existing user.
ALTER TABLE "User" ADD COLUMN "phoneNumberHash" TEXT;
CREATE UNIQUE INDEX "User_phoneNumberHash_key" ON "User"("phoneNumberHash");
