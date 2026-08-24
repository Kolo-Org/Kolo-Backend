import { prisma } from '../lib/prisma';
import { StellarService, InsufficientReserveError } from './stellar.service';
import { WhatsAppService } from './whatsapp.service';
import { decrypt } from '../utils/encryption.util';
import { config } from '../config/env';
import { t } from './locale.service';
import { redisClient } from '../lib/redis';
import { registerSecret, unregisterSecret } from '../utils/secret-registry';
import { logSecretAccess } from '../utils/audit-logger';

const stellarService = new StellarService();
const whatsappService = new WhatsAppService();

import { isSupportedLanguage } from './locale.service';

export class UserService {
    public async getOrCreateUser(phoneNumber: string, locale?: string): Promise<any> {
        let user = await prisma.user.findUnique({
            where: { phoneNumber }
        });

        if (!user) {
            const wallet = stellarService.generateWallet();

            try {
                await stellarService.fundTestnetAccount(wallet.publicKey);
            } catch (err) {
                console.error('Failed to fund testnet account:', err);
            }

            if (config.USDC_ISSUER_PUBLIC_KEY) {
                try {
                    // Use the newly generated wallet, not user.stellarWallet (user is null here)
                    let secretBuffer: Buffer | null = null;
                    try {
                        secretBuffer = decrypt(wallet.encryptedSecret, wallet.iv, wallet.authTag);
                        registerSecret(secretBuffer);
                        await stellarService.createTrustline(secretBuffer, 'USDC', config.USDC_ISSUER_PUBLIC_KEY);
                        // No user.id yet since user is not created - skip audit log for this initial trustline
                    } finally {
                        if (secretBuffer) {
                            unregisterSecret(secretBuffer);
                            secretBuffer.fill(0);
                        }
                    }
                } catch (err) {
                    if (err instanceof InsufficientReserveError) {
                        await whatsappService.sendMessage(phoneNumber, t('wallet.usdc_trustline_low_reserve', 'en'));
                    } else {
                        console.error('Failed to create USDC trustline:', err);
                    }
                }
            }

            const walletData = JSON.stringify({
                publicKey: wallet.publicKey,
                encryptedSecret: wallet.encryptedSecret,
                iv: wallet.iv,
                authTag: wallet.authTag,
            });

            const defaultLang = locale && isSupportedLanguage(locale) ? locale : 'en';

            user = await prisma.user.create({
                data: {
                    phoneNumber,
                    stellarWallet: walletData,
                    language: defaultLang,
                }
            });
            console.log(`Created new user for ${phoneNumber} with wallet ${wallet.publicKey}`);
        }
        return user;
    }

    public async resolveUser(target: string): Promise<any> {
        if (target.startsWith('@')) {
            return await prisma.user.findUnique({ where: { username: target.substring(1) } });
        } else {
            return await prisma.user.findUnique({ where: { phoneNumber: target } });
        }
    }

    public async updateUserLanguage(phoneNumber: string, language: string): Promise<any> {
        return await prisma.user.update({
            where: { phoneNumber },
            data: { language }
        });
    }

    public async getUserByPublicKey(publicKey: string): Promise<any> {
        const cacheKey = `address_to_username:${publicKey}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (e) {
            console.error('Redis get error:', e);
        }

        const user = await prisma.user.findFirst({
            where: { stellarWallet: { contains: publicKey } },
            select: { username: true, phoneNumber: true }
        });

        if (user) {
            try {
                await redisClient.set(cacheKey, JSON.stringify(user), 'EX', 3600); // 1 hour TTL
            } catch (e) {
                console.error('Redis set error:', e);
            }
        }
        return user;
    }
}
