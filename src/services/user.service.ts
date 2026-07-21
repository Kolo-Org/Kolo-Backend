import { prisma } from '../lib/prisma';
import { StellarService } from './stellar.service';

const stellarService = new StellarService();

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
}
