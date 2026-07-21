import { StellarService } from './stellar.service';

export interface ContractCallResult {
    hash: string;
}

/**
 * Integration seam for the Ajo/Esusu rotation smart contract. Group pooled
 * funds don't yet have their own on-chain custodial wallet/contract in this
 * codebase, so `payout` and `resetCycle` are backed by classic Stellar
 * payments from a shared treasury signer for now. Swap the internals here
 * once the Soroban rotation contract is deployed — callers in
 * `PayoutService` only depend on this interface, not the transport.
 */
export class SorobanService {
    private stellarService: StellarService;

    constructor(stellarService?: StellarService) {
        this.stellarService = stellarService ?? new StellarService();
    }

    public async payout(sourceSecret: string, recipientPublicKey: string, amount: string): Promise<ContractCallResult> {
        const result = await this.stellarService.sendPayment(sourceSecret, recipientPublicKey, amount);
        return { hash: result.hash };
    }

    /**
     * Marks a full rotation as complete on-chain. Until the rotation contract
     * exists, cycle bookkeeping lives entirely in Postgres, so this is a no-op
     * kept as the seam PayoutService calls into.
     */
    public async resetCycle(groupId: string): Promise<void> {
        console.log(`[SorobanService] Cycle reset for group ${groupId} (no-op: rotation contract not yet deployed)`);
    }
}
