import * as StellarSdk from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export class AuthService {
    private serverKeypair: StellarSdk.Keypair;
    private homeDomain: string;
    private networkPassphrase: string;

    constructor() {
        if (!config.SEP10_SERVER_SECRET) {
            // For testing, fallback to a random keypair if not configured, though a real app should persist this
            this.serverKeypair = StellarSdk.Keypair.random();
        } else {
            this.serverKeypair = StellarSdk.Keypair.fromSecret(config.SEP10_SERVER_SECRET);
        }
        
        this.homeDomain = config.SEP10_HOME_DOMAIN;
        this.networkPassphrase = config.STELLAR_NETWORK === 'TESTNET'
            ? StellarSdk.Networks.TESTNET
            : StellarSdk.Networks.PUBLIC;
    }

    /**
     * Generates a SEP-10 challenge transaction for the given client public key.
     */
    public generateChallenge(clientPublicKey: string): string {
        const transaction = StellarSdk.WebAuth.buildChallengeTx(
            this.serverKeypair,
            clientPublicKey,
            this.homeDomain,
            300, // Challenge is valid for 5 minutes
            this.networkPassphrase,
            this.homeDomain
        );

        return transaction;
    }

    /**
     * Verifies the client's signed SEP-10 challenge transaction and returns a JWT if valid.
     */
    public verifyChallengeAndGenerateToken(transactionXdr: string): { token: string, account: string } {
        const transaction = StellarSdk.WebAuth.readChallengeTx(
            transactionXdr,
            this.serverKeypair.publicKey(),
            this.networkPassphrase,
            this.homeDomain,
            this.homeDomain
        );

        // Verify the threshold, throwing an error if invalid
        StellarSdk.WebAuth.verifyChallengeTxSigners(
            transactionXdr,
            this.serverKeypair.publicKey(),
            this.networkPassphrase,
            [transaction.clientAccountID], // The client's public key who requested the challenge
            this.homeDomain,
            this.homeDomain
        );

        // If we reach here, the transaction is verified.
        // Generate a JWT for the authenticated client.
        const token = jwt.sign(
            { sub: transaction.clientAccountID },
            config.JWT_SECRET,
            { expiresIn: '24h' }
        );

        return { token, account: transaction.clientAccountID };
    }
}

export const authService = new AuthService();
