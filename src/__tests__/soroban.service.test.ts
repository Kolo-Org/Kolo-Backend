import * as StellarSdk from '@stellar/stellar-sdk';
import fs from 'fs';
import path from 'path';
import { SorobanService } from '../services/soroban.service';
import { config } from '../config/env';
import { observabilityService } from '../services/observability.service';

jest.mock('../services/observability.service', () => ({
    observabilityService: {
        logInfo: jest.fn(),
        logError: jest.fn(),
        alertCriticalFailure: jest.fn(),
    },
}));

describe('SorobanService Unit Tests', () => {
    let sorobanService: SorobanService;
    let mockServer: any;
    let deployerKeypair: StellarSdk.Keypair;
    let testWasmPath: string;

    beforeEach(() => {
        jest.clearAllMocks();
        deployerKeypair = StellarSdk.Keypair.random();
        sorobanService = new SorobanService('https://soroban-testnet.stellar.org');

        mockServer = {
            simulateTransaction: jest.fn(),
            sendTransaction: jest.fn(),
            getTransaction: jest.fn(),
            getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(deployerKeypair.publicKey(), '100')),
        };

        sorobanService.server = mockServer;
        testWasmPath = path.resolve(__dirname, 'test_contract.wasm');
        fs.writeFileSync(testWasmPath, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    });

    afterEach(() => {
        if (fs.existsSync(testWasmPath)) {
            fs.unlinkSync(testWasmPath);
        }
    });

    describe('loadContractWasm', () => {
        it('should successfully load contract wasm binary', () => {
            const wasm = sorobanService.loadContractWasm(testWasmPath);
            expect(wasm).toBeDefined();
            expect(wasm.length).toBe(8);
        });

        it('should throw an error if the wasm file does not exist', () => {
            expect(() => {
                sorobanService.loadContractWasm('/invalid/path/contract.wasm');
            }).toThrow('WASM contract file not found');
        });
    });

    describe('simulateAndAssembleTransaction', () => {
        // Raw simulation response helper — matches what the Soroban RPC actually returns
        function makeRawSimSuccess(overrides: Record<string, any> = {}) {
            return {
                transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // empty SorobanTransactionData XDR
                minResourceFee: '500',
                results: [{ xdr: 'AAAAAQ==', auth: [] }], // scvVoid XDR
                latestLedger: 100,
                ...overrides,
            };
        }

        it('should simulate transaction and bump fee if base fee < 1000', async () => {
            const account = new StellarSdk.Account(deployerKeypair.publicKey(), '100');
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: '100',
                networkPassphrase: StellarSdk.Networks.TESTNET,
            })
                .addOperation(StellarSdk.Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115, 109]) }))
                .setTimeout(30)
                .build();

            mockServer.simulateTransaction.mockResolvedValue(makeRawSimSuccess());

            const assembled = await sorobanService.simulateAndAssembleTransaction(tx);
            expect(Number(assembled.fee)).toBeGreaterThanOrEqual(1000);
            expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
        });

        it('should retry up to 3 times if RPC simulation returns PENDING status', async () => {
            const account = new StellarSdk.Account(deployerKeypair.publicKey(), '100');
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: '100',
                networkPassphrase: StellarSdk.Networks.TESTNET,
            })
                .addOperation(StellarSdk.Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115, 109]) }))
                .setTimeout(30)
                .build();

            const mockSimPending = { status: 'PENDING' };

            mockServer.simulateTransaction
                .mockResolvedValueOnce(mockSimPending)
                .mockResolvedValueOnce(makeRawSimSuccess());

            const assembled = await sorobanService.simulateAndAssembleTransaction(tx);
            expect(assembled).toBeDefined();
            expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(2);
        });

        it('should throw an error if simulation returns an error', async () => {
            const account = new StellarSdk.Account(deployerKeypair.publicKey(), '100');
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: '100',
                networkPassphrase: StellarSdk.Networks.TESTNET,
            })
                .addOperation(StellarSdk.Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115, 109]) }))
                .setTimeout(30)
                .build();

            mockServer.simulateTransaction.mockResolvedValue({
                error: 'Host function execution failed',
            });

            await expect(sorobanService.simulateAndAssembleTransaction(tx)).rejects.toThrow('Simulation failed');
        });

        it('should handle restorePreamble if present in simulation response', async () => {
            const account = new StellarSdk.Account(deployerKeypair.publicKey(), '100');
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: '100',
                networkPassphrase: StellarSdk.Networks.TESTNET,
            })
                .addOperation(StellarSdk.Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115, 109]) }))
                .setTimeout(30)
                .build();

            mockServer.simulateTransaction.mockResolvedValue(
                makeRawSimSuccess({
                    restorePreamble: {
                        transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // base64 XDR, same as empty SorobanDataBuilder
                        minResourceFee: '200',
                    },
                })
            );

            const assembled = await sorobanService.simulateAndAssembleTransaction(tx);
            expect(assembled).toBeDefined();
        });
    });

    describe('submitTransaction', () => {
        it('should return transaction hash when submission succeeds immediately', async () => {
            const account = new StellarSdk.Account(deployerKeypair.publicKey(), '100');
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: '1000',
                networkPassphrase: StellarSdk.Networks.TESTNET,
            })
                .addOperation(StellarSdk.Operation.bumpSequence({ bumpTo: '105' }))
                .setTimeout(30)
                .build();

            mockServer.sendTransaction.mockResolvedValue({
                status: 'SUCCESS',
                hash: 'mock_tx_hash_123',
            });

            const hash = await sorobanService.submitTransaction(tx, deployerKeypair);
            expect(hash).toBe('mock_tx_hash_123');
        });

        it('should poll getTransaction until status is SUCCESS', async () => {
            const account = new StellarSdk.Account(deployerKeypair.publicKey(), '100');
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: '1000',
                networkPassphrase: StellarSdk.Networks.TESTNET,
            })
                .addOperation(StellarSdk.Operation.bumpSequence({ bumpTo: '105' }))
                .setTimeout(30)
                .build();

            mockServer.sendTransaction.mockResolvedValue({
                status: 'PENDING',
                hash: 'mock_tx_hash_456',
            });

            mockServer.getTransaction
                .mockResolvedValueOnce({ status: 'NOT_FOUND' })
                .mockResolvedValueOnce({ status: 'SUCCESS' });

            const hash = await sorobanService.submitTransaction(tx, deployerKeypair);
            expect(hash).toBe('mock_tx_hash_456');
            expect(mockServer.getTransaction).toHaveBeenCalledTimes(2);
        });

        it('should throw error when submission status returns ERROR', async () => {
            const account = new StellarSdk.Account(deployerKeypair.publicKey(), '100');
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: '1000',
                networkPassphrase: StellarSdk.Networks.TESTNET,
            })
                .addOperation(StellarSdk.Operation.bumpSequence({ bumpTo: '105' }))
                .setTimeout(30)
                .build();

            mockServer.sendTransaction.mockResolvedValue({
                status: 'ERROR',
                errorResultXdr: 'mock_error_xdr',
            });

            await expect(sorobanService.submitTransaction(tx, deployerKeypair)).rejects.toThrow('Transaction submission failed');
        });
    });

    describe('deployGroupContract orchestrator', () => {
        let originalSecretKey: string;

        beforeAll(() => {
            originalSecretKey = config.DEPLOYER_SECRET_KEY;
        });

        afterAll(() => {
            config.DEPLOYER_SECRET_KEY = originalSecretKey;
        });

        it('should throw an error if DEPLOYER_SECRET_KEY is missing', async () => {
            config.DEPLOYER_SECRET_KEY = '';
            await expect(
                sorobanService.deployGroupContract({
                    groupId: 'group-1',
                    name: 'Savings Club',
                    contributionAmount: '500',
                })
            ).rejects.toThrow('DEPLOYER_SECRET_KEY is not configured');
            expect(observabilityService.logError).toHaveBeenCalled();
        });

        it('should complete contract deployment flow when mocks return success', async () => {
            config.DEPLOYER_SECRET_KEY = deployerKeypair.secret();

            const mockWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
            jest.spyOn(sorobanService, 'loadContractWasm').mockReturnValue(mockWasm);
            jest.spyOn(sorobanService, 'uploadWasm').mockResolvedValue({
                wasmHash: StellarSdk.hash(mockWasm),
                txHash: 'hash_upload',
            });
            jest.spyOn(sorobanService, 'createCustomContract').mockResolvedValue({
                contractId: 'CC4UXKYIYM2AKACS7I3PS63C7ONUYVBPIAGU5V35WULTZERJ4KOR7ZTF',
                txHash: 'hash_create',
            });
            jest.spyOn(sorobanService, 'initializeContract').mockResolvedValue({
                txHash: 'hash_init',
            });

            const result = await sorobanService.deployGroupContract({
                groupId: 'group-100',
                name: 'Test Group',
                contributionAmount: '100',
            });

            expect(result.contractId).toBe('CC4UXKYIYM2AKACS7I3PS63C7ONUYVBPIAGU5V35WULTZERJ4KOR7ZTF');
            expect(result.latency).toBeGreaterThanOrEqual(0);
            expect(observabilityService.logInfo).toHaveBeenCalledWith(
                'Contract deployment completed successfully',
                expect.objectContaining({ groupId: 'group-100' })
            );
        });

        it('should log error and alert when network timeout or deployment error occurs', async () => {
            config.DEPLOYER_SECRET_KEY = deployerKeypair.secret();

            jest.spyOn(sorobanService, 'loadContractWasm').mockImplementation(() => {
                throw new Error('Network timeout during file load');
            });

            await expect(
                sorobanService.deployGroupContract({
                    groupId: 'group-error',
                    name: 'Failed Group',
                    contributionAmount: '200',
                })
            ).rejects.toThrow('Network timeout during file load');

            expect(observabilityService.logError).toHaveBeenCalled();
            expect(observabilityService.alertCriticalFailure).toHaveBeenCalled();
        });
    });
});
