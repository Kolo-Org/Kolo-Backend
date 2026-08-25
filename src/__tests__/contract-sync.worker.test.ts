/**
 * Tests for the contract-sync reconciliation worker.
 *
 * Coverage:
 *  - Skips groups without a Soroban contract or non-DEPLOYED status
 *  - Skips members without a Stellar wallet
 *  - Detects and persists mismatches when on-chain > DB
 *  - Detects and persists mismatches when on-chain < DB
 *  - Does NOT persist a record when amounts match
 *  - Handles queryContribution() errors gracefully
 *  - Applies a 1-stroop tolerance for floating-point rounding
 */
import { runReconciliation, ReconciliationSummary } from '../workers/contract-sync.worker';
import { SorobanService } from '../services/soroban.service';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../services/observability.service', () => ({
    observabilityService: {
        logInfo: jest.fn(),
        logError: jest.fn(),
        alertCriticalFailure: jest.fn(),
    },
}));

jest.mock('../middleware/prisma-encryption.middleware', () => ({
    applyEncryptionMiddleware: jest.fn(),
}));

// BullMQ queue mock (scheduleReconciliation is a no-op in tests)
jest.mock('../queue/contract-sync.queue', () => ({
    scheduleReconciliation: jest.fn().mockResolvedValue(undefined),
    getContractSyncQueue: jest.fn().mockReturnValue({ add: jest.fn() }),
    closeContractSyncQueue: jest.fn(),
}));

// Mock Prisma — use a factory so jest.fn() instances are created inside
// the mock factory closure, avoiding the TDZ hoisting problem.
const prismaMocks = {
    findManyGroups: jest.fn(),
    findManyContributions: jest.fn(),
    create: jest.fn(),
};

jest.mock('@prisma/client', () => {
    const mockFns = {
        findManyGroups: jest.fn(),
        findManyContributions: jest.fn(),
        create: jest.fn(),
    };
    // Expose so tests can configure them via the module
    (global as any).__prismaMocks = mockFns;
    return {
        PrismaClient: jest.fn().mockImplementation(() => ({
            savingsGroup: { findMany: (...args: any[]) => (global as any).__prismaMocks.findManyGroups(...args) },
            contribution: { findMany: (...args: any[]) => (global as any).__prismaMocks.findManyContributions(...args) },
            reconciliationMismatch: { create: (...args: any[]) => (global as any).__prismaMocks.create(...args) },
        })),
        Prisma: {
            Decimal: class Decimal {
                constructor(public val: number) {}
                toString() { return String(this.val); }
            },
        },
    };
});

// Convenience aliases that point to the global mock fns
function getMocks() {
    return (global as any).__prismaMocks as {
        findManyGroups: jest.Mock;
        findManyContributions: jest.Mock;
        create: jest.Mock;
    };
}

// Helper: build a minimal group record
function makeGroup(overrides: Record<string, any> = {}) {
    return {
        id: 'g1',
        name: 'Test Group',
        deploymentStatus: 'DEPLOYED',
        stellarContractId: 'CONTRACT_ID',
        currentCycleStart: new Date('2026-08-01'),
        currentCycleEnd: new Date('2026-09-01'),
        members: [
            {
                user: {
                    id: 'u1',
                    stellarWallet: JSON.stringify({ publicKey: 'G_PUB_1' }),
                },
            },
        ],
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runReconciliation()', () => {
    let mockSorobanService: jest.Mocked<Pick<SorobanService, 'queryContribution'>>;

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset the global mocks between tests
        const m = getMocks();
        m.findManyGroups.mockReset();
        m.findManyContributions.mockReset();
        m.create.mockReset();
        // Safe defaults so tests that don't configure these don't throw
        m.findManyGroups.mockResolvedValue([]);
        m.findManyContributions.mockResolvedValue([]);
        m.create.mockResolvedValue({ id: 'mm_default' });
        mockSorobanService = {
            queryContribution: jest.fn().mockResolvedValue(0n),
        };
    });

    it('skips groups without a stellarContractId', async () => {
        // The real Prisma query filters out groups with null stellarContractId.
        // Mock that behaviour by returning an empty array.
        getMocks().findManyGroups.mockResolvedValue([]);

        const summary = await runReconciliation(mockSorobanService as any);

        expect(summary.membersChecked).toBe(0);
        expect(mockSorobanService.queryContribution).not.toHaveBeenCalled();
        expect(getMocks().create).not.toHaveBeenCalled();
    });

    it('skips members without a Stellar wallet', async () => {
        getMocks().findManyGroups.mockResolvedValue([
            makeGroup({
                members: [{ user: { id: 'u2', stellarWallet: null } }],
            }),
        ]);

        const summary = await runReconciliation(mockSorobanService as any);

        expect(summary.membersChecked).toBe(1);
        expect(mockSorobanService.queryContribution).not.toHaveBeenCalled();
        expect(getMocks().create).not.toHaveBeenCalled();
    });

    it('logs NO mismatch when on-chain and DB amounts match', async () => {
        getMocks().findManyGroups.mockResolvedValue([makeGroup()]);
        // 10 XLM = 100_000_000 stroops
        mockSorobanService.queryContribution.mockResolvedValue(100_000_000n);
        getMocks().findManyContributions.mockResolvedValue([{ amount: 10 }]); // 10 XLM

        const summary = await runReconciliation(mockSorobanService as any);

        expect(summary.mismatchesFound).toBe(0);
        expect(getMocks().create).not.toHaveBeenCalled();
    });

    it('applies 1-stroop tolerance for floating-point rounding', async () => {
        getMocks().findManyGroups.mockResolvedValue([makeGroup()]);
        mockSorobanService.queryContribution.mockResolvedValue(100_000_001n); // 1 stroop over
        getMocks().findManyContributions.mockResolvedValue([{ amount: 10 }]); // exactly 10 XLM

        const summary = await runReconciliation(mockSorobanService as any);

        expect(summary.mismatchesFound).toBe(0);
        expect(getMocks().create).not.toHaveBeenCalled();
    });

    it('detects and persists a mismatch when on-chain > DB (crash-recovery scenario)', async () => {
        getMocks().findManyGroups.mockResolvedValue([makeGroup()]);
        // on-chain: 10 XLM (confirmed), DB: 0 (write didn't happen)
        mockSorobanService.queryContribution.mockResolvedValue(100_000_000n);
        getMocks().findManyContributions.mockResolvedValue([]); // no DB records
        getMocks().create.mockResolvedValue({ id: 'mm1' });

        const summary = await runReconciliation(mockSorobanService as any);

        expect(summary.mismatchesFound).toBe(1);
        expect(getMocks().create).toHaveBeenCalledTimes(1);
        expect(getMocks().create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    groupId: 'g1',
                    userId: 'u1',
                }),
            }),
        );
    });

    it('detects and persists a mismatch when DB > on-chain', async () => {
        getMocks().findManyGroups.mockResolvedValue([makeGroup()]);
        // on-chain: 5 XLM, DB: 10 XLM
        mockSorobanService.queryContribution.mockResolvedValue(50_000_000n);
        getMocks().findManyContributions.mockResolvedValue([{ amount: 10 }]);
        getMocks().create.mockResolvedValue({ id: 'mm2' });

        const summary = await runReconciliation(mockSorobanService as any);

        expect(summary.mismatchesFound).toBe(1);
        expect(getMocks().create).toHaveBeenCalledTimes(1);
    });

    it('records an error but continues when queryContribution throws', async () => {
        getMocks().findManyGroups.mockResolvedValue([
            makeGroup({
                members: [
                    { user: { id: 'u1', stellarWallet: JSON.stringify({ publicKey: 'G_PUB_1' }) } },
                    { user: { id: 'u2', stellarWallet: JSON.stringify({ publicKey: 'G_PUB_2' }) } },
                ],
            }),
        ]);
        // First member throws, second is fine
        mockSorobanService.queryContribution
            .mockRejectedValueOnce(new Error('RPC timeout'))
            .mockResolvedValueOnce(0n);
        getMocks().findManyContributions.mockResolvedValue([]);

        const summary = await runReconciliation(mockSorobanService as any);

        expect(summary.errors).toHaveLength(1);
        expect(summary.errors[0]).toContain('RPC timeout');
        expect(summary.mismatchesFound).toBe(0);
        // u2 was still processed
        expect(mockSorobanService.queryContribution).toHaveBeenCalledTimes(2);
    });

    it('scans multiple groups independently', async () => {
        const group2 = makeGroup({ id: 'g2', stellarContractId: 'CONTRACT_2' });
        getMocks().findManyGroups.mockResolvedValue([makeGroup(), group2]);
        mockSorobanService.queryContribution.mockResolvedValue(0n);
        getMocks().findManyContributions.mockResolvedValue([]);

        const summary = await runReconciliation(mockSorobanService as any);

        expect(summary.groupsScanned).toBe(2);
        expect(summary.membersChecked).toBe(2);
    });
});
