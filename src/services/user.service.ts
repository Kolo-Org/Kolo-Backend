import { prisma } from '../lib/prisma';
import { StellarService, InsufficientReserveError } from './stellar.service';
import { WhatsAppService } from './whatsapp.service';
import { decrypt } from '../utils/encryption.util';
import { config } from '../config/env';
import { t } from './locale.service';

const stellarService = new StellarService();
const whatsappService = new WhatsAppService();

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

            if (config.USDC_ISSUER_PUBLIC_KEY) {
                try {
                    const secret = decrypt(wallet.encryptedSecret, wallet.iv, wallet.authTag);
                    await stellarService.createTrustline(secret, 'USDC', config.USDC_ISSUER_PUBLIC_KEY);
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
}
