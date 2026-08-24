-- Run AFTER scripts/backfill-phone-encryption.ts has migrated all rows.
-- From this point on every user row must carry the lookup hash.
DROP INDEX IF EXISTS "User_phoneNumberHash_key";
ALTER TABLE "User" ALTER COLUMN "phoneNumberHash" SET NOT NULL;
CREATE UNIQUE INDEX "User_phoneNumberHash_key" ON "User"("phoneNumberHash");

-- The phone number column now holds ciphertext blobs; uniqueness is enforced
-- by phoneNumberHash instead.
DROP INDEX IF EXISTS "User_phoneNumber_key";
