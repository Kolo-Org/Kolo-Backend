import { PrismaClient } from '@prisma/client';
import { encrypt } from '../src/utils/encryption.util';

const prisma = new PrismaClient();

async function main() {
    console.log('Starting wallet encryption migration...');
    
    const users = await prisma.user.findMany({
        where: {
            stellarWallet: {
                not: null,
            }
        }
    });

    let count = 0;

    for (const user of users) {
        if (!user.stellarWallet) continue;
        
        const parts = user.stellarWallet.split(':');
        
        // Old format: publicKey:secretKey (2 parts)
        if (parts.length === 2) {
            const publicKey = parts[0];
            const secretKey = parts[1];
            
            try {
                const { encryptedText, iv, authTag } = encrypt(secretKey);
                const newWalletData = `${publicKey}:${encryptedText}:${iv}:${authTag}`;
                
                await prisma.user.update({
                    where: { id: user.id },
                    data: { stellarWallet: newWalletData }
                });
                
                count++;
                console.log(`Successfully encrypted wallet for user ID: ${user.id}`);
            } catch (error) {
                console.error(`Failed to encrypt wallet for user ID: ${user.id}`, error);
            }
        }
    }

    console.log(`Migration completed. Encrypted ${count} wallets.`);
}

main()
    .catch(e => {
        console.error('Migration failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
