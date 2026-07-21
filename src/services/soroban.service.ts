import * as StellarSdk from '@stellar/stellar-sdk';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/env';
import { observabilityService } from './observability.service';

// Module-level compatibility aliases for issue requirements
if (!(StellarSdk.Operation as any).uploadWasm) {
    (StellarSdk.Operation as any).uploadWasm = StellarSdk.Operation.uploadContractWasm;
}

if (!(StellarSdk as any).SorobanRpc) {
    (StellarSdk as any).SorobanRpc = StellarSdk.rpc;
}

export interface DeployGroupContractParams {
    groupId: string;
    name: string;
    contributionAmount: string | number | bigint;
    adminPublicKey?: string;
    wasmPath?: string;
}

export interface DeploymentResult {
    contractId: string;
    latency: number;
}

/**
 * Low-level helper for deploying and invoking Soroban contracts.
 *
 * This service is intentionally designed to work against the configured
 * Soroban RPC endpoint and to operate in both testnet and public network modes.
 */
export class SorobanService {
    public server: StellarSdk.rpc.Server;

    /**
     * Create a SorobanService binding to the configured RPC endpoint.
     *
     * @param rpcUrl optional override for the Soroban RPC endpoint URL.
     */
    constructor(rpcUrl?: string) {
        const url = rpcUrl || config.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
        this.server = new StellarSdk.rpc.Server(url);
    }

    /**
     * Returns the active Stellar network passphrase based on application config.
     */
    public getNetworkPassphrase(): string {
        return config.STELLAR_NETWORK === 'TESTNET'
            ? StellarSdk.Networks.TESTNET
            : StellarSdk.Networks.PUBLIC;
    }

    /**
     * Loads the compiled .wasm contract binary from a configurable path.
     */
    public loadContractWasm(wasmPath?: string): Buffer {
        const targetPath = wasmPath || config.CONTRACT_WASM_PATH;
        const resolvedPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);

        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`WASM contract file not found at path: ${resolvedPath}`);
        }

        return fs.readFileSync(resolvedPath);
    }

    /**
     * Simulates transaction, handles retries for PENDING responses, applies restorePreamble if present,
     * and assembles resource limits & bumps fee to >= 1000 stroops.
     */
    public async simulateAndAssembleTransaction(
        tx: StellarSdk.Transaction,
        server?: StellarSdk.rpc.Server
    ): Promise<StellarSdk.Transaction> {
        const srv = server || this.server;
        let simRes: StellarSdk.rpc.Api.SimulateTransactionResponse | null = null;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;
            simRes = await srv.simulateTransaction(tx);

            if (simRes && (simRes as any).status === 'PENDING') {
                if (attempts < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
                    continue;
                }
            }
            break;
        }

        if (!simRes) {
            throw new Error('Simulation failed: No response received from Soroban RPC.');
        }

        if (StellarSdk.rpc.Api.isSimulationError(simRes)) {
            throw new Error(`Simulation failed: ${(simRes as any).error || 'Unknown simulation error'}`);
        }

        // Handle restorePreamble for expired ledger entries
        if ((simRes as any).restorePreamble) {
            const preamble = (simRes as any).restorePreamble;
            if (preamble.transactionData) {
                // In the raw RPC response, transactionData is a base64 XDR string.
                // After parseRawSimulation, it becomes a SorobanDataBuilder instance.
                const sorobanData = typeof preamble.transactionData === 'string'
                    ? new StellarSdk.SorobanDataBuilder(preamble.transactionData).build()
                    : preamble.transactionData.build();

                tx = StellarSdk.TransactionBuilder.cloneFrom(tx, {
                    fee: tx.fee,
                    sorobanData,
                }).build();
            }
        }

        // Assemble transaction to attach resource limits from simulation
        const txBuilder = StellarSdk.rpc.assembleTransaction(tx, simRes);
        let assembledTx = txBuilder.build();

        // Enforce fee bumping: if base fee < 1000 stroops, bump to 1000
        const currentFee = Number(assembledTx.fee);
        if (isNaN(currentFee) || currentFee < 1000) {
            assembledTx = StellarSdk.TransactionBuilder.cloneFrom(assembledTx, {
                fee: '1000',
            }).build();
        }

        return assembledTx;
    }

    /**
     * Signs and submits transaction, polling if needed until confirmation.
     */
    public async submitTransaction(
        tx: StellarSdk.Transaction,
        signerKeypair: StellarSdk.Keypair,
        server?: StellarSdk.rpc.Server
    ): Promise<string> {
        const srv = server || this.server;
        tx.sign(signerKeypair);

        const response = await srv.sendTransaction(tx);
        const responseStatus = (response as any).status as string;

        if (responseStatus === 'ERROR') {
            throw new Error(`Transaction submission failed: ${JSON.stringify((response as any).errorResultXdr || response)}`);
        }

        const hash = (response as any).hash as string | undefined;
        if (!hash) {
            throw new Error('Transaction submission did not return a valid hash.');
        }

        if (responseStatus === 'SUCCESS') {
            return hash;
        }

        // Poll for confirmation if PENDING or TRY_AGAIN_LATER
        let polls = 0;
        const maxPolls = 10;
        while (polls < maxPolls) {
            polls++;
            await new Promise((res) => setTimeout(res, 1000));
            const statusRes = await srv.getTransaction(hash);
            const txStatus = (statusRes as any).status as string;

            if (txStatus === 'SUCCESS') {
                return hash;
            }
            if (txStatus === 'FAILED') {
                throw new Error(`Transaction failed on ledger: ${hash}`);
            }
        }

        return hash;
    }

    /**
     * Uploads the WASM binary to the Stellar network using StellarSdk.Operation.uploadContractWasm / uploadWasm.
     */
    public async uploadWasm(
        deployerKeypair: StellarSdk.Keypair,
        wasmBuffer: Buffer,
        server?: StellarSdk.rpc.Server
    ): Promise<{ wasmHash: Buffer; txHash: string }> {
        const srv = server || this.server;
        const account = await srv.getAccount(deployerKeypair.publicKey());

        const uploadOp = (StellarSdk.Operation as any).uploadWasm
            ? (StellarSdk.Operation as any).uploadWasm({ wasm: wasmBuffer })
            : StellarSdk.Operation.uploadContractWasm({ wasm: wasmBuffer });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(uploadOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);
        const txHash = await this.submitTransaction(tx, deployerKeypair, srv);
        const wasmHash = StellarSdk.hash(wasmBuffer);

        return { wasmHash, txHash };
    }

    /**
     * Creates the contract instance using StellarSdk.Operation.createCustomContract().
     */
    public async createCustomContract(
        deployerKeypair: StellarSdk.Keypair,
        wasmHash: Buffer,
        salt?: Buffer,
        server?: StellarSdk.rpc.Server
    ): Promise<{ contractId: string; txHash: string }> {
        const srv = server || this.server;
        const actualSalt = salt || crypto.randomBytes(32);
        const account = await srv.getAccount(deployerKeypair.publicKey());

        const createOp = StellarSdk.Operation.createCustomContract({
            address: new StellarSdk.Address(deployerKeypair.publicKey()),
            wasmHash,
            salt: actualSalt,
        });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(createOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);
        const txHash = await this.submitTransaction(tx, deployerKeypair, srv);

        // Derive contract ID from address, salt, and network passphrase
        const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeContractId(
            new StellarSdk.xdr.HashIdPreimageContractId({
                networkId: StellarSdk.hash(Buffer.from(this.getNetworkPassphrase())),
                contractIdPreimage: StellarSdk.xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                    new StellarSdk.xdr.ContractIdPreimageFromAddress({
                        address: new StellarSdk.Address(deployerKeypair.publicKey()).toScAddress(),
                        salt: actualSalt,
                    })
                ),
            })
        );
        const contractId = StellarSdk.StrKey.encodeContract(StellarSdk.hash(preimage.toXDR()));

        return { contractId, txHash };
    }

    /**
     * Invokes the initialize() method on the deployed contract with group parameters.
     */
    public async initializeContract(
        deployerKeypair: StellarSdk.Keypair,
        contractId: string,
        params: {
            admin: string;
            usdcTokenAddress: string;
            groupName: string;
            contributionAmount: string | number | bigint;
        },
        server?: StellarSdk.rpc.Server
    ): Promise<{ txHash: string }> {
        const srv = server || this.server;
        const account = await srv.getAccount(deployerKeypair.publicKey());

        const amountBigInt = typeof params.contributionAmount === 'bigint'
            ? params.contributionAmount
            : BigInt(Math.floor(Number(params.contributionAmount)));

        const args = [
            new StellarSdk.Address(params.admin).toScVal(),
            new StellarSdk.Address(params.usdcTokenAddress).toScVal(),
            StellarSdk.nativeToScVal(params.groupName),
            StellarSdk.nativeToScVal(amountBigInt, { type: 'i128' }),
        ];

        const invokeOp = StellarSdk.Operation.invokeContractFunction({
            contract: contractId,
            function: 'initialize',
            args,
        });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(invokeOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);
        const txHash = await this.submitTransaction(tx, deployerKeypair, srv);

        return { txHash };
    }

    /**
     * High-level contract deployment pipeline orchestrator.
     */
    public async deployGroupContract(params: DeployGroupContractParams): Promise<DeploymentResult> {
        const startTime = Date.now();
        observabilityService.logInfo('Starting contract deployment pipeline', { groupId: params.groupId });

        if (!config.DEPLOYER_SECRET_KEY) {
            const err = new Error('DEPLOYER_SECRET_KEY is not configured in environment variables.');
            const latency = Date.now() - startTime;
            observabilityService.logError('Contract deployment failed: Missing secret key', err, { groupId: params.groupId, latency });
            await observabilityService.alertCriticalFailure('Soroban deployment configuration error', err, { groupId: params.groupId, latency });
            throw err;
        }

        try {
            const deployerKeypair = StellarSdk.Keypair.fromSecret(config.DEPLOYER_SECRET_KEY);
            const admin = params.adminPublicKey || deployerKeypair.publicKey();
            const usdcTokenAddress = config.USDC_TOKEN_ADDRESS || 'CCW67TSBXSHOMEVDBLAEXGPSDMT2OVL4TJBB25KVEA2MOWFK76OO5SS7';

            // 1. Load WASM
            const wasmBuffer = this.loadContractWasm(params.wasmPath);

            // 2. Upload WASM
            const { wasmHash } = await this.uploadWasm(deployerKeypair, wasmBuffer);

            // 3. Create Contract Instance
            const { contractId } = await this.createCustomContract(deployerKeypair, wasmHash);

            // 4. Invoke initialize()
            await this.initializeContract(deployerKeypair, contractId, {
                admin,
                usdcTokenAddress,
                groupName: params.name,
                contributionAmount: params.contributionAmount,
            });

            const latency = Date.now() - startTime;
            observabilityService.logInfo('Contract deployment completed successfully', {
                groupId: params.groupId,
                contractId,
                latency,
            });

            return { contractId, latency };
        } catch (error: any) {
            const latency = Date.now() - startTime;
            observabilityService.logError('Contract deployment failed', error, {
                groupId: params.groupId,
                error: error?.message || String(error),
                latency,
            });
            await observabilityService.alertCriticalFailure('Contract deployment failed', error, {
                groupId: params.groupId,
                error: error?.message || String(error),
                latency,
            });
            throw error;
        }
    }
}

export const sorobanService = new SorobanService();
