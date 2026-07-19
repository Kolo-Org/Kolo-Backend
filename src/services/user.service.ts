import { prisma } from '../lib/prisma';
import { StellarService } from './stellar.service';
import { redisClient } from '../lib/redis';

const stellarService = new StellarService();

export class UserService {
    public async getOrCreateUser(phoneNumber: string): Promise<any> {
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

            const walletData = JSON.stringify({
                publicKey: wallet.publicKey,
                encryptedSecret: wallet.encryptedSecret,
                iv: wallet.iv,
                authTag: wallet.authTag,
            });

            user = await prisma.user.create({
                data: {
                    phoneNumber,
                    stellarWallet: walletData,
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
