import { Worker, Job } from 'bullmq';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { encryptBuffer, decrypt } from '../utils/encryption.util';
import { redisClient } from '../lib/redis';
import { registerSecret, unregisterSecret } from '../utils/secret-registry';
import { logSecretAccess } from '../utils/audit-logger';

export const keyRotationQueueName = 'key-rotation-queue';

export const startKeyRotationWorker = () => {
    const keyRotationWorker = new Worker(
        keyRotationQueueName,
        async (job: Job) => {
            const currentVersion = config.CURRENT_ENCRYPTION_KEY_VERSION;
            
            let processedCount = 0;
            let hasMore = true;
            let failedIds: string[] = [];

            while (hasMore) {
                const users = await prisma.user.findMany({
                    where: {
                        encryptionKeyVersion: {
                            lt: currentVersion
                        },
                        stellarWallet: {
                            not: null
                        },
                        id: {
                            notIn: failedIds
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

                    const oldVersion = user.encryptionKeyVersion;
                    let secretBuffer: Buffer | null = null;

                    try {
                        const wallet = JSON.parse(user.stellarWallet);
                        
                        // Decrypt with the old key version
                        secretBuffer = decrypt(
                            wallet.encryptedSecret,
                            wallet.iv,
                            wallet.authTag,
                            oldVersion
                        );
                        registerSecret(secretBuffer);

                        // Re-encrypt with the new current key version
                        const reEncrypted = encryptBuffer(secretBuffer);

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
                        await logSecretAccess(user.id, 'KEY_ROTATION', true);
                        processedCount++;

                        // Rate limit to max 50 per second (approx 20ms per op)
                        await new Promise(resolve => setTimeout(resolve, 20));
                    } catch (error) {
                        console.error(`Failed to rotate key for user ${user.id}`, error);
                        await logSecretAccess(user.id, 'KEY_ROTATION', false, error instanceof Error ? error.message : String(error));
                        failedIds.push(user.id);
                    } finally {
                        if (secretBuffer) {
                            unregisterSecret(secretBuffer);
                            secretBuffer.fill(0);
                        }
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
