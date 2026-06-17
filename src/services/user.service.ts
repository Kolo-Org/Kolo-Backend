import { PrismaClient } from '@prisma/client';
import { StellarService } from './stellar.service';

const prisma = new PrismaClient();
const stellarService = new StellarService();

export class UserService {
    public async getOrCreateUser(phoneNumber: string): Promise<any> {
        let user = await prisma.user.findUnique({
            where: { phoneNumber }
        });

        if (!user) {
            // Generate Stellar wallet
            const wallet = stellarService.generateWallet();
            
            // Fund wallet with Friendbot asynchronously
            stellarService.fundTestnetAccount(wallet.publicKey).catch(err => {
                console.error('Failed to fund testnet account:', err);
            });

            // Store encrypted wallet data
            const walletData = `${wallet.publicKey}:${wallet.encryptedSecret}:${wallet.iv}:${wallet.authTag}`;

            user = await prisma.user.create({
                data: {
                    phoneNumber,
                    stellarWallet: walletData
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
