import * as StellarSdk from '@stellar/stellar-sdk';
import { config } from '../config/env';
import { encrypt } from '../utils/encryption.util';

export class StellarService {
    private server: StellarSdk.Horizon.Server;

    constructor() {
        if (config.STELLAR_NETWORK === 'PUBLIC') {
            this.server = new StellarSdk.Horizon.Server('https://horizon.stellar.org');
        } else {
            this.server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
        }
    }

    public generateWallet() {
        const pair = StellarSdk.Keypair.random();
        const { encryptedText, iv, authTag } = encrypt(pair.secret());
        return {
            publicKey: pair.publicKey(),
            encryptedSecret: encryptedText,
            iv,
            authTag,
        };
    }

    public async fundTestnetAccount(publicKey: string): Promise<void> {
        if (config.STELLAR_NETWORK === 'TESTNET') {
            try {
                // Using axios for friendbot request since node-fetch is not installed
                const axios = require('axios');
                await axios.get(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
                console.log(`Friendbot successfully funded ${publicKey}`);
            } catch (e) {
                console.error("Friendbot funding failed:", e);
            }
        }
    }

    public async checkBalance(publicKey: string): Promise<string> {
        try {
            const account = await this.server.loadAccount(publicKey);
            const balance = account.balances.find((b) => b.asset_type === 'native');
            return balance ? balance.balance : '0';
        } catch (error) {
            console.error('Error checking balance:', error);
            return 'Error checking balance or account not funded.';
        }
    }

    public async sendPayment(sourceSecret: string, destinationPublicKey: string, amount: string): Promise<any> {
        const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecret);
        const sourceAccount = await this.server.loadAccount(sourceKeypair.publicKey());

        const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: (await this.server.fetchBaseFee()).toString(),
            networkPassphrase: config.STELLAR_NETWORK === 'TESTNET' 
                ? StellarSdk.Networks.TESTNET 
                : StellarSdk.Networks.PUBLIC
        })
        .addOperation(StellarSdk.Operation.payment({
            destination: destinationPublicKey,
            asset: StellarSdk.Asset.native(),
            amount: amount,
        }))
        .setTimeout(30)
        .build();

        transaction.sign(sourceKeypair);
        return await this.server.submitTransaction(transaction);
    }
}
