import { PrismaClient } from '@prisma/client';
import { encryptField, hmacPhone, isEncryptedFieldBlob, decryptField } from '../src/utils/encryption.util';

// Uses its own PrismaClient WITHOUT the encryption middleware so the script
// sees exactly what is stored and performs the encryption explicitly.
const prisma = new PrismaClient();

const BATCH_SIZE = 100;

function plaintextOf(storedValue: string): string {
    return isEncryptedFieldBlob(storedValue) ? decryptField(storedValue) : storedValue;
}

async function main() {
    console.log('Starting phone number encryption backfill...');

    let cursor: string | undefined = undefined;
    let migrated = 0;
    let skipped = 0;

    // Iterate every user row (unfiltered, so cursor pagination stays stable
    // even as rows are updated).
    do {
        const users = await prisma.user.findMany({
            take: BATCH_SIZE,
            orderBy: { id: 'asc' },
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            select: { id: true, phoneNumber: true },
        });

        for (const user of users) {
            cursor = user.id;

            if (!user.phoneNumber) {
                skipped++;
                continue;
            }

            try {
                const data: Record<string, unknown> = {};

                if (!isEncryptedFieldBlob(user.phoneNumber)) {
                    data.phoneNumber = encryptField(user.phoneNumber);
                }

                data.phoneNumberHash = hmacPhone(plaintextOf(user.phoneNumber));

                await prisma.user.update({
                    where: { id: user.id },
                    data,
                });
                migrated++;
            } catch (error) {
                console.error(`Failed to encrypt phone number for user ID: ${user.id}`, error);
            }
        }
    } while (cursor);

    console.log(`Backfill completed. Migrated ${migrated} phone numbers, skipped ${skipped} rows.`);
}

main()
    .catch(e => {
        console.error('Backfill failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
