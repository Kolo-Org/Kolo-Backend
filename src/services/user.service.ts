import { prisma } from '../lib/prisma';
import { StellarService } from './stellar.service';
const stellarService = new StellarService();

export class UserService {
  public async getOrCreateUser(phoneNumber: string): Promise<any> {
    let user = await prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (!user) {
      // Generate Stellar wallet
      const wallet = stellarService.generateWallet();

      try {
        await stellarService.fundTestnetAccount(wallet.publicKey);
      } catch (err) {
        console.error('Failed to fund testnet account:', err);
      }

      // Store publicKey:secret in the stellarWallet field for this custodial MVP
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
          language: 'en',
        },
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
