import * as StellarSdk from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import crypto from 'crypto';
import { redisClient } from '../lib/redis';

export class AuthService {
    private serverKeypair: StellarSdk.Keypair;
    private homeDomain: string;
    private networkPassphrase: string;
    private horizon: StellarSdk.Horizon.Server;

    constructor() {
        if (!config.SEP10_SERVER_SECRET) {
            throw new Error('SEP10_SERVER_SECRET is required');
        }
        this.serverKeypair = StellarSdk.Keypair.fromSecret(config.SEP10_SERVER_SECRET);
        
        this.homeDomain = config.SEP10_HOME_DOMAIN;
        this.networkPassphrase = config.STELLAR_NETWORK === 'TESTNET'
            ? StellarSdk.Networks.TESTNET
            : StellarSdk.Networks.PUBLIC;
        this.horizon = new StellarSdk.Horizon.Server(
            config.STELLAR_NETWORK === 'PUBLIC'
                ? 'https://horizon.stellar.org'
                : 'https://horizon-testnet.stellar.org'
        );
    }

    /**
     * Generates a SEP-10 challenge transaction for the given client public key.
     */
    public generateChallenge(clientPublicKey: string): string {
        const transaction = StellarSdk.WebAuth.buildChallengeTx(
            this.serverKeypair,
            clientPublicKey,
            this.homeDomain,
            config.SEP10_CHALLENGE_TTL_SECONDS || 300,
            this.networkPassphrase,
            this.homeDomain
        );

        return transaction;
    }

    /**
     * Verifies the client's signed SEP-10 challenge transaction and returns a JWT if valid.
     */
    public async verifyChallengeAndGenerateToken(transactionXdr: string): Promise<{ token: string, account: string }> {
        // Replay protection: hash the XDR to use as a unique ID
        const txHash = crypto.createHash('sha256').update(transactionXdr).digest('hex');
        const redisKey = `sep10:challenge:${txHash}`;
        
        // Attempt to atomically set the key if it doesn't exist. If not set, it's a replay.
        const acquired = await redisClient.set(redisKey, 'consumed', 'EX', config.SEP10_CHALLENGE_TTL_SECONDS || 300, 'NX');
        if (!acquired) {
            throw new Error('Challenge transaction has already been consumed');
        }

        const transaction = StellarSdk.WebAuth.readChallengeTx(
            transactionXdr,
            this.serverKeypair.publicKey(),
            this.networkPassphrase,
            this.homeDomain,
            this.homeDomain
        );

        let signers;
        let threshold = 1;
        try {
            const account = await this.horizon.loadAccount(transaction.clientAccountID);
            signers = account.signers;
            // Use low threshold for SEP-10 or 1 if not set
            threshold = account.thresholds.low_threshold || 1;
        } catch (error: any) {
            if (error.response && error.response.status === 404) {
                signers = [{ key: transaction.clientAccountID, weight: 1, type: 'ed25519_public_key' }];
                threshold = 1;
            } else {
                throw error;
            }
        }

        // Verify the threshold, throwing an error if invalid
        StellarSdk.WebAuth.verifyChallengeTxThreshold(
            transactionXdr,
            this.serverKeypair.publicKey(),
            this.networkPassphrase,
            threshold,
            signers as any,
            this.homeDomain,
            this.homeDomain
        );

        // If we reach here, the transaction is verified.
        // Generate a JWT for the authenticated client.
        const token = jwt.sign(
            { sub: transaction.clientAccountID },
            config.JWT_SECRET as string,
            { expiresIn: '24h' }
        );

        return { token, account: transaction.clientAccountID };
    }
}

export const authService = new AuthService();
