import * as StellarSdk from '@stellar/stellar-sdk';
import { authService } from '../services/auth.service';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

describe('Auth Service - SEP-10', () => {
    it('should generate and verify a challenge successfully', () => {
        // 1. Client keypair
        const clientKeypair = StellarSdk.Keypair.random();
        
        // 2. Generate challenge
        const challengeXdr = authService.generateChallenge(clientKeypair.publicKey());
        
        expect(challengeXdr).toBeDefined();
        
        // 3. Client signs the challenge
        const networkPassphrase = config.STELLAR_NETWORK === 'TESTNET' ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC;
        const transaction = new StellarSdk.Transaction(challengeXdr, networkPassphrase);
        transaction.sign(clientKeypair);
        const signedXdr = transaction.toEnvelope().toXDR('base64');
        
        // 4. Verify challenge
        const { token, account } = authService.verifyChallengeAndGenerateToken(signedXdr);
        
        expect(account).toBe(clientKeypair.publicKey());
        expect(token).toBeDefined();
        
        // 5. Verify token manually
        const decoded = jwt.verify(token, config.JWT_SECRET) as any;
        expect(decoded.sub).toBe(clientKeypair.publicKey());
    });
});
