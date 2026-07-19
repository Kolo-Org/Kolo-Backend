import * as StellarSdk from '@stellar/stellar-sdk';
import { config } from '../config/env';
import { encrypt } from '../utils/encryption.util';

export interface GeneratedWallet {
    publicKey: string;
    encryptedSecret: string;
    iv: string;
    authTag: string;
}

export interface AssetBalance {
    assetCode: string;
    issuer: string;
    balance: string;
}

export class InsufficientReserveError extends Error {
    constructor() {
        super('Account does not have enough XLM to cover the trustline reserve.');
        this.name = 'InsufficientReserveError';
    }
}

export class StellarService {
    private server: StellarSdk.Horizon.Server;

    constructor() {
        if (config.STELLAR_NETWORK === 'PUBLIC') {
            this.server = new StellarSdk.Horizon.Server('https://horizon.stellar.org');
        } else {
            this.server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
        }
    }

    public generateWallet(): GeneratedWallet {
        const pair = StellarSdk.Keypair.random();
        const secretBuffer = Buffer.from(pair.secret(), 'utf8');

        try {
            const { encryptedText, iv, authTag } = encrypt(secretBuffer.toString('utf8'));
            return {
                publicKey: pair.publicKey(),
                encryptedSecret: encryptedText,
                iv,
                authTag,
            };
        } finally {
            secretBuffer.fill(0);
        }
    }

    public async fundTestnetAccount(publicKey: string): Promise<void> {
        if (config.STELLAR_NETWORK !== 'TESTNET') return;

        try {
            const axios = require('axios');
            const response = await axios.get(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
            if (response.status !== 200) {
                throw new Error(`Friendbot funding failed with status ${response.status}`);
            }
            console.log(`Friendbot successfully funded ${publicKey}`);
        } catch (error) {
            console.error('Friendbot funding failed:', error);
        }
    }

    public async checkBalance(publicKey: string): Promise<AssetBalance[]> {
        try {
            const account = await this.server.loadAccount(publicKey);
            return account.balances.map((b) => ({
                assetCode: b.asset_type === 'native' ? 'XLM' : (b as any).asset_code,
                issuer: b.asset_type === 'native' ? '' : (b as any).asset_issuer,
                balance: b.balance,
            }));
        } catch (error) {
            console.error('Error checking balance:', error);
            return [];
        }
    }

    public async sendPayment(sourceSecret: string, destinationPublicKey: string, amount: string): Promise<any> {
        const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecret);
        const sourceAccount = await this.server.loadAccount(sourceKeypair.publicKey());

        const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: (await this.server.fetchBaseFee()).toString(),
            networkPassphrase: this.networkPassphrase(),
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

    /**
     * Establishes a trustline for an issued asset (e.g. USDC) so the account can hold it.
     * No-op if the trustline already exists. Only ever called for assets we've explicitly
     * configured (e.g. USDC_ISSUER_PUBLIC_KEY) — never auto-create trustlines for unknown assets.
     */
    public async createTrustline(userSecret: string, assetCode: string, issuerPublicKey: string): Promise<void> {
        const sourceKeypair = StellarSdk.Keypair.fromSecret(userSecret);

        let sourceAccount;
        try {
            sourceAccount = await this.server.loadAccount(sourceKeypair.publicKey());
        } catch (error: any) {
            if (error?.response?.status === 404) {
                throw new InsufficientReserveError();
            }
            throw error;
        }

        const alreadyTrusted = sourceAccount.balances.some(
            (b) => b.asset_type !== 'native' && (b as any).asset_code === assetCode && (b as any).asset_issuer === issuerPublicKey,
        );
        if (alreadyTrusted) return;

        const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: (await this.server.fetchBaseFee()).toString(),
            networkPassphrase: this.networkPassphrase(),
        })
        .addOperation(StellarSdk.Operation.changeTrust({
            asset: new StellarSdk.Asset(assetCode, issuerPublicKey),
        }))
        .setTimeout(30)
        .build();

        transaction.sign(sourceKeypair);

        try {
            await this.server.submitTransaction(transaction);
        } catch (error) {
            if (this.isLowReserveError(error)) {
                throw new InsufficientReserveError();
            }
            throw error;
        }
    }

    private networkPassphrase(): string {
        return config.STELLAR_NETWORK === 'TESTNET'
            ? StellarSdk.Networks.TESTNET
            : StellarSdk.Networks.PUBLIC;
    }

    private isLowReserveError(error: any): boolean {
        const resultCodes = error?.response?.data?.extras?.result_codes;
        return resultCodes?.operations?.includes('op_low_reserve') || resultCodes?.transaction === 'tx_insufficient_balance';
    }
}
