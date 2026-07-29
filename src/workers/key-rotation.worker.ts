import { Worker, Job } from 'bullmq';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { encrypt, decrypt } from '../utils/encryption.util';
import { redisClient } from '../lib/redis';

export const keyRotationQueueName = 'key-rotation-queue';

export const startKeyRotationWorker = () => {
    const keyRotationWorker = new Worker(
        keyRotationQueueName,
        async (job: Job) => {
            const currentVersion = config.CURRENT_ENCRYPTION_KEY_VERSION;
            
            let processedCount = 0;
            let hasMore = true;

            while (hasMore) {
                const users = await prisma.user.findMany({
                    where: {
                        encryptionKeyVersion: {
                            lt: currentVersion
                        },
                        stellarWallet: {
                            not: null
                        }
                    },
                    take: 100,
                    orderBy: {
                        id: 'asc'
                    }
                });

                if (users.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const user of users) {
                    if (!user.stellarWallet) continue;

                    const wallet = JSON.parse(user.stellarWallet);
                    const oldVersion = user.encryptionKeyVersion;

                    try {
                        // Decrypt with the old key version
                        const decryptedSecret = decrypt(
                            wallet.encryptedSecret,
                            wallet.iv,
                            wallet.authTag,
                            oldVersion
                        );

                        // Re-encrypt with the new current key version
                        const reEncrypted = encrypt(decryptedSecret);

                        const newWallet = {
                            ...wallet,
                            encryptedSecret: reEncrypted.encryptedText,
                            iv: reEncrypted.iv,
                            authTag: reEncrypted.authTag,
                            keyVersion: reEncrypted.keyVersion
                        };

                        // Atomic update
                        await prisma.$transaction(async (tx) => {
                            await tx.user.update({
                                where: { id: user.id },
                                data: {
                                    stellarWallet: JSON.stringify(newWallet),
                                    encryptionKeyVersion: currentVersion
                                }
                            });
                        });

                        console.log(`Re-encrypted wallet for user ${user.id}, v${oldVersion} -> v${currentVersion}`);
                        processedCount++;

                        // Rate limit to max 50 per second (approx 20ms per op)
                        await new Promise(resolve => setTimeout(resolve, 20));
                    } catch (error) {
                        console.error(`Failed to rotate key for user ${user.id}`, error);
                    }
                }
            }

            return { processedCount };
        },
        { connection: redisClient as any }
    );

    keyRotationWorker.on('failed', (job, err) => {
        console.error(`Key rotation job failed:`, err);
    });

    return keyRotationWorker;
};
