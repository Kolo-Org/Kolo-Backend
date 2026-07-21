import * as StellarSdk from '@stellar/stellar-sdk';
import { config } from '../config/env';
import { encrypt } from '../utils/encryption.util';
import { redisClient } from '../lib/redis';
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

/**
 * Error thrown when a Stellar account does not have enough XLM to create a trustline.
 */
export class InsufficientReserveError extends Error {
    constructor() {
        super('Account does not have enough XLM to cover the trustline reserve.');
        this.name = 'InsufficientReserveError';
    }
}

/**
 * A helper service for basic Stellar account operations, wallet generation, and transaction history.
 */
export class StellarService {
    private server: StellarSdk.Horizon.Server;

    /**
     * Initializes the Stellar horizon connection based on configured network mode.
     */
    constructor() {
        if (config.STELLAR_NETWORK === 'PUBLIC') {
            this.server = new StellarSdk.Horizon.Server('https://horizon.stellar.org');
        } else {
            this.server = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
        }
    }

    /**
     * Generates a new Stellar wallet and encrypts its secret key for secure storage.
     */
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

    /**
     * Uses Friendbot to fund a testnet account with XLM.
     * No-op when running against the public network.
     */
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

    /**
     * Returns current asset balances for a given Stellar account.
     */
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

    /**
     * Sends a native XLM payment from one account to another and invalidates cached transaction history.
     */
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
        const result = await this.server.submitTransaction(transaction);
        
        // Invalidate cache
        try {
            const invalidateKeys = async (pubKey: string) => {
                let cursor = '0';
                do {
                    const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', `tx_history:${pubKey}:*`, 'COUNT', 100);
                    if (keys.length > 0) await redisClient.del(...keys);
                    cursor = nextCursor;
                } while (cursor !== '0');
            };
            await invalidateKeys(sourceKeypair.publicKey());
            await invalidateKeys(destinationPublicKey);
        } catch (e) {
            console.error('Failed to invalidate cache', e);
        }

        return result;
    }

    /**
     * Loads the transaction history for a Stellar public key, with optional cursor pagination.
     * This method also caches results in Redis for repeated queries.
     */
    public async getTransactionHistory(publicKey: string, cursor?: string, limit: number = 10): Promise<{ transactions: any[], nextCursor: string | null }> {
        const pageNum = cursor || '1';
        const cacheKey = `tx_history:${publicKey}:page:${pageNum}`;
        
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (e) {
            console.error('Redis cache error:', e);
            // continue to fetch from horizon
        }

        let response;
        try {
            let req = this.server.transactions().forAccount(publicKey).order('desc').limit(limit);
            if (cursor && cursor !== '1') {
                req = req.cursor(cursor);
            }
            response = await req.call();
        } catch (error: any) {
            if (error?.response?.status === 429) {
                // Backoff and retry once
                await new Promise(resolve => setTimeout(resolve, 2000));
                try {
                    let req = this.server.transactions().forAccount(publicKey).order('desc').limit(limit);
                    if (cursor && cursor !== '1') {
                        req = req.cursor(cursor);
                    }
                    response = await req.call();
                } catch (retryError) {
                    throw new Error('Transaction history is temporarily unavailable. Please try again later.');
                }
            } else if (error?.response?.status === 404) {
                throw new Error('No transaction history — your wallet hasn\'t been funded yet');
            } else {
                console.error('Error fetching transactions:', error);
                throw new Error('Transaction history is temporarily unavailable. Please try again later.');
            }
        }

        const parsedTransactions = [];
        const opsPromises = response.records.map((tx: any) => tx.operations().catch((e: any) => null));
        const opsResults = await Promise.all(opsPromises);

        for (let i = 0; i < response.records.length; i++) {
            const tx = response.records[i];
            const ops = opsResults[i];
            
            let type = 'unknown';
            let amount = '0';
            let asset = 'XLM';
            let counterparty = 'Unknown';

            try {
                if (ops && ops.records && ops.records.length > 0) {
                    const op = ops.records[0] as any;
                    if (op.type === 'payment') {
                        amount = op.amount;
                        asset = op.asset_type === 'native' ? 'XLM' : op.asset_code;
                        if (op.to === publicKey) {
                            type = 'payment received';
                            counterparty = op.from;
                        } else {
                            type = 'payment sent';
                            counterparty = op.to;
                        }
                    } else if (op.type === 'create_account') {
                        type = 'account created';
                        amount = op.starting_balance;
                        counterparty = op.funder;
                    } else if (op.type === 'change_trust') {
                        type = 'trustline change';
                        asset = op.asset_code || 'Unknown';
                    } else {
                        type = op.type;
                    }
                }
            } catch (opErr) {
                console.error('Error parsing ops for tx', tx.id, opErr);
            }

            parsedTransactions.push({
                date: tx.created_at,
                type,
                amount,
                asset,
                counterparty,
                hash: tx.hash
            });
        }

        let nextCursor: string | null = null;
        if (response.records.length === limit) {
            nextCursor = response.records[response.records.length - 1].paging_token;
        }

        const result = { transactions: parsedTransactions, nextCursor };

        try {
            await redisClient.set(cacheKey, JSON.stringify(result), 'EX', 300); // 5 minutes TTL
        } catch (e) {
            console.error('Redis set error:', e);
        }

        return result;
    }

    /**
     * Establishes a trustline for a user account to hold a custom issued asset.
     * No-op if the trustline already exists.
     * Throws InsufficientReserveError when the account lacks the reserve needed for trustlines.
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
