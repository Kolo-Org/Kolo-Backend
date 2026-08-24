-- Run AFTER scripts/backfill-phone-encryption.ts has migrated all rows.
-- phoneNumberHash stays nullable: users without a stored phone number never
-- get a hash. Uniqueness on the hash is what moves off the plaintext column.

-- The phone number column now holds ciphertext blobs; uniqueness is enforced
-- by phoneNumberHash instead.
DROP INDEX IF EXISTS "User_phoneNumber_key";
