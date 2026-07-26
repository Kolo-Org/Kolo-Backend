import { PrismaClient } from '@prisma/client';
import {
    PayoutService,
    PayoutOrderLockedError,
    InvalidPayoutOrderError,
} from '../services/payout.service';
import { config } from '../config/env';

jest.mock('@prisma/client', () => {
    const mPrismaClient = {
        savingsGroup: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        payoutOrderLog: {
            create: jest.fn(),
        },
        contribution: {
            findMany: jest.fn(),
        },
        payout: {
            findFirst: jest.fn(),
            create: jest.fn(),
        },
        groupMember: {
            findMany: jest.fn(),
        },
        $transaction: jest.fn((ops: any[]) => Promise.resolve(ops)),
    };
    return { PrismaClient: jest.fn(() => mPrismaClient) };
});

jest.mock('../queue/contribution-scheduler.queue', () => ({
    enqueueCycleEnd: jest.fn().mockResolvedValue(null),
}));

const { enqueueCycleEnd } = require('../queue/contribution-scheduler.queue');

function makeMember(userId: string, role: string, overrides: any = {}) {
    return {
        userId,
        role,
        groupId: 'g1',
        joinedAt: new Date(2026, 0, 1),
        user: {
            id: userId,
            phoneNumber: `+1${userId}`,
            username: null,
            stellarWallet: JSON.stringify({ publicKey: `PUB_${userId}` }),
            ...overrides,
        },
    };
}

describe('PayoutService', () => {
    let prisma: any;
    let payoutService: PayoutService;
    let mockSendMessage: jest.Mock;
    let mockSorobanPayout: jest.Mock;
    let mockSorobanResetCycle: jest.Mock;
    let originalTreasurySecret: string;

    beforeAll(() => {
        originalTreasurySecret = config.GROUP_TREASURY_SECRET;
        config.GROUP_TREASURY_SECRET = 'TEST_TREASURY_SECRET';
    });

    afterAll(() => {
        config.GROUP_TREASURY_SECRET = originalTreasurySecret;
    });

    beforeEach(() => {
        prisma = new PrismaClient();

        // mockReset (not clearAllMocks) so queued mockResolvedValueOnce values from a
        // previous test never leak into the next one.
        prisma.savingsGroup.findUnique.mockReset();
        prisma.savingsGroup.update.mockReset();
        prisma.payoutOrderLog.create.mockReset();
        prisma.contribution.findMany.mockReset();
        prisma.payout.findFirst.mockReset();
        prisma.payout.create.mockReset();
        prisma.groupMember.findMany.mockReset().mockResolvedValue([]);
        prisma.$transaction.mockReset().mockImplementation((ops: any[]) => Promise.resolve(ops));
        (enqueueCycleEnd as jest.Mock).mockReset().mockResolvedValue(null);

        mockSendMessage = jest.fn().mockResolvedValue(true);
        mockSorobanPayout = jest.fn().mockResolvedValue({ hash: 'tx_hash_1' });
        mockSorobanResetCycle = jest.fn().mockResolvedValue(undefined);

        payoutService = new PayoutService(
            { sendMessage: mockSendMessage } as any,
            { payout: mockSorobanPayout, resetCycle: mockSorobanResetCycle } as any,
        );
    });

    describe('setPayoutOrder', () => {
        const baseGroup = {
            id: 'g1',
            name: 'Ajo Circle',
            payoutOrder: null,
            payoutOrderLockedAt: null,
            members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER'), makeMember('u3', 'MEMBER')],
        };

        it('enforces that only the creator can set the order', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(baseGroup);

            await expect(payoutService.setPayoutOrder('g1', 'u2', ['u2', 'u1', 'u3'])).rejects.toThrow(
                'Only the group creator can set the payout order.',
            );
            expect(prisma.$transaction).not.toHaveBeenCalled();
        });

        it('rejects an order once locked for the cycle', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce({ ...baseGroup, payoutOrderLockedAt: new Date() });

            await expect(payoutService.setPayoutOrder('g1', 'u1', ['u1', 'u2', 'u3'])).rejects.toThrow(
                PayoutOrderLockedError,
            );
        });

        it('rejects an order missing a current member', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(baseGroup);

            await expect(payoutService.setPayoutOrder('g1', 'u1', ['u1', 'u2'])).rejects.toThrow(
                InvalidPayoutOrderError,
            );
        });

        it('rejects an order with duplicate members', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(baseGroup);

            await expect(payoutService.setPayoutOrder('g1', 'u1', ['u1', 'u1', 'u2'])).rejects.toThrow(
                InvalidPayoutOrderError,
            );
        });

        it('persists a valid reordering and logs the audit trail', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(baseGroup);

            const result = await payoutService.setPayoutOrder('g1', 'u1', ['u3', 'u1', 'u2']);

            expect(result).toEqual(['u3', 'u1', 'u2']);
            expect(prisma.savingsGroup.update).toHaveBeenCalledWith({
                where: { id: 'g1' },
                data: { payoutOrder: ['u3', 'u1', 'u2'] },
            });
            expect(prisma.payoutOrderLog.create).toHaveBeenCalledWith({
                data: {
                    groupId: 'g1',
                    changedBy: 'u1',
                    previousOrder: ['u1', 'u2', 'u3'], // default join order since payoutOrder was null
                    newOrder: ['u3', 'u1', 'u2'],
                    reason: 'REORDER',
                },
            });
        });
    });

    describe('lockOrderForCycle', () => {
        it('locks in the join order the first time it is called', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce({
                id: 'g1',
                payoutOrder: null,
                payoutOrderLockedAt: null,
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER')],
            });

            await payoutService.lockOrderForCycle('g1');

            expect(prisma.savingsGroup.update).toHaveBeenCalledWith({
                where: { id: 'g1' },
                data: { payoutOrderLockedAt: expect.any(Date), payoutOrder: ['u1', 'u2'] },
            });
        });

        it('is a no-op once already locked', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce({
                id: 'g1',
                payoutOrderLockedAt: new Date(),
                members: [],
            });

            await payoutService.lockOrderForCycle('g1');

            expect(prisma.savingsGroup.update).not.toHaveBeenCalled();
        });
    });

    describe('executePayout — order enforcement', () => {
        it('pays out the member at currentPayoutIndex, not just the first member', async () => {
            const group = {
                id: 'g1',
                name: 'Ajo Circle',
                contributionAmount: 10,
                currentPayoutIndex: 1,
                totalCycles: 0,
                payoutOrder: ['u1', 'u2', 'u3'],
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER'), makeMember('u3', 'MEMBER')],
            };
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group).mockResolvedValueOnce(group);
            prisma.payout.findFirst.mockResolvedValueOnce(null);
            prisma.payout.create.mockResolvedValueOnce({ id: 'payout-1', recipientId: 'u2' });

            await payoutService.executePayout('g1');

            expect(mockSorobanPayout).toHaveBeenCalledWith('TEST_TREASURY_SECRET', 'PUB_u2', '30');
            expect(prisma.payout.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ recipientId: 'u2', cycleNumber: 1 }),
            });
            expect(prisma.savingsGroup.update).toHaveBeenCalledWith({
                where: { id: 'g1' },
                data: { currentPayoutIndex: 2 },
            });
        });

        it('is idempotent — will not double-pay a cycle that already has a payout record', async () => {
            const group = {
                id: 'g1',
                name: 'Ajo Circle',
                contributionAmount: 10,
                currentPayoutIndex: 0,
                totalCycles: 0,
                payoutOrder: ['u1', 'u2'],
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER')],
            };
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group);
            const existing = { id: 'existing-payout', cycleNumber: 1 };
            prisma.payout.findFirst.mockResolvedValueOnce(existing);

            const result = await payoutService.executePayout('g1');

            expect(result).toBe(existing);
            expect(mockSorobanPayout).not.toHaveBeenCalled();
            expect(prisma.payout.create).not.toHaveBeenCalled();
        });
    });

    describe('executePayout — cycle completion', () => {
        it('triggers a cycle reset once the last member in rotation is paid', async () => {
            const group = {
                id: 'g1',
                name: 'Ajo Circle',
                contributionAmount: 10,
                currentPayoutIndex: 1,
                totalCycles: 0,
                payoutOrder: ['u1', 'u2'],
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER')],
            };
            prisma.savingsGroup.findUnique
                .mockResolvedValueOnce(group) // executePayout's own lookup
                .mockResolvedValueOnce({ ...group, currentPayoutIndex: 2 }); // completeCycle's lookup
            prisma.payout.findFirst.mockResolvedValueOnce(null);
            prisma.payout.create.mockResolvedValueOnce({ id: 'payout-2', recipientId: 'u2' });
            prisma.groupMember.findMany.mockResolvedValue(group.members);

            await payoutService.executePayout('g1');

            expect(mockSorobanResetCycle).toHaveBeenCalledWith('g1');
            expect(prisma.savingsGroup.update).toHaveBeenCalledWith({
                where: { id: 'g1' },
                data: {
                    totalCycles: 1,
                    currentPayoutIndex: 0,
                    deadlineExtensionsUsed: 0,
                    payoutOrderLockedAt: null,
                },
            });
            expect(mockSendMessage).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('Cycle 1 complete'),
            );
        });

        it('does not trigger a reset when members remain in the rotation', async () => {
            const group = {
                id: 'g1',
                name: 'Ajo Circle',
                contributionAmount: 10,
                currentPayoutIndex: 0,
                totalCycles: 0,
                payoutOrder: ['u1', 'u2', 'u3'],
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER'), makeMember('u3', 'MEMBER')],
            };
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group);
            prisma.payout.findFirst.mockResolvedValueOnce(null);
            prisma.payout.create.mockResolvedValueOnce({ id: 'payout-1', recipientId: 'u1' });

            await payoutService.executePayout('g1');

            expect(mockSorobanResetCycle).not.toHaveBeenCalled();
        });
    });

    describe('proceedWithPartialPool — partial pool calculations', () => {
        it('pays out only the amount actually contributed this cycle', async () => {
            const group = {
                id: 'g1',
                name: 'Ajo Circle',
                contributionAmount: 10,
                currentPayoutIndex: 0,
                totalCycles: 0,
                currentCycleStart: new Date(2026, 0, 1),
                currentCycleEnd: new Date(2026, 0, 8),
                payoutOrder: ['u1', 'u2', 'u3'],
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER'), makeMember('u3', 'MEMBER')],
            };
            // Status lookup (getCycleContributionStatus) — only 2 of 3 contributed
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group).mockResolvedValueOnce(group);
            prisma.contribution.findMany.mockResolvedValueOnce([
                { userId: 'u1', status: 'COMPLETED' },
                { userId: 'u2', status: 'COMPLETED' },
            ]);
            prisma.payout.findFirst.mockResolvedValueOnce(null);
            prisma.payout.create.mockResolvedValueOnce({ id: 'payout-partial' });

            await payoutService.proceedWithPartialPool('g1');

            // 2 contributors * 10 XLM = 20, not the full 3 * 10 = 30 pool
            expect(mockSorobanPayout).toHaveBeenCalledWith('TEST_TREASURY_SECRET', 'PUB_u1', '20');
        });
    });

    describe('skipDefaultingMember — member removed mid-cycle', () => {
        it('moves the defaulting member to the back of the rotation and logs it', async () => {
            const group = {
                id: 'g1',
                payoutOrder: ['u1', 'u2', 'u3'],
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER'), makeMember('u3', 'MEMBER')],
            };
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group);

            const newOrder = await payoutService.skipDefaultingMember('g1', 'u1', 'u2');

            expect(newOrder).toEqual(['u1', 'u3', 'u2']);
            expect(prisma.savingsGroup.update).toHaveBeenCalledWith({
                where: { id: 'g1' },
                data: { payoutOrder: ['u1', 'u3', 'u2'] },
            });
            expect(prisma.payoutOrderLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ reason: 'SKIP_DEFAULT', changedBy: 'u1' }),
            });
        });

        it('rejects when the requester is not the creator', async () => {
            const group = {
                id: 'g1',
                payoutOrder: ['u1', 'u2'],
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER')],
            };
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group);

            await expect(payoutService.skipDefaultingMember('g1', 'u2', 'u1')).rejects.toThrow(
                'Only the group creator can skip a defaulting member.',
            );
        });
    });

    describe('extendDeadline', () => {
        it('extends the cycle end by 24h and reschedules the cycle-end job', async () => {
            const cycleEnd = new Date(2026, 0, 8);
            prisma.savingsGroup.findUnique.mockResolvedValueOnce({
                id: 'g1',
                name: 'Ajo Circle',
                currentCycleEnd: cycleEnd,
                deadlineExtensionsUsed: 0,
            });

            const newEnd = await payoutService.extendDeadline('g1');

            expect(newEnd.getTime()).toBe(cycleEnd.getTime() + 24 * 60 * 60 * 1000);
            expect(prisma.savingsGroup.update).toHaveBeenCalledWith({
                where: { id: 'g1' },
                data: { currentCycleEnd: newEnd, deadlineExtensionsUsed: { increment: 1 } },
            });
            expect(enqueueCycleEnd).toHaveBeenCalledWith('g1', expect.any(Number));
        });

        it('refuses to extend past the configured maximum', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce({
                id: 'g1',
                name: 'Ajo Circle',
                currentCycleEnd: new Date(),
                deadlineExtensionsUsed: 2,
            });

            await expect(payoutService.extendDeadline('g1')).rejects.toThrow(
                'Maximum deadline extensions (2) already used for this cycle.',
            );
        });
    });

    describe('processCycleEnd', () => {
        it('pays out automatically when every member has contributed', async () => {
            const group = {
                id: 'g1',
                name: 'Ajo Circle',
                contributionAmount: 10,
                currentPayoutIndex: 0,
                totalCycles: 0,
                currentCycleStart: null,
                currentCycleEnd: null,
                payoutOrder: ['u1', 'u2'],
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER')],
            };
            // getCycleContributionStatus lookup, then executePayout's own lookup
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group).mockResolvedValueOnce(group);
            prisma.contribution.findMany.mockResolvedValueOnce([
                { userId: 'u1', status: 'COMPLETED' },
                { userId: 'u2', status: 'COMPLETED' },
            ]);
            prisma.payout.findFirst.mockResolvedValueOnce(null);
            prisma.payout.create.mockResolvedValueOnce({ id: 'payout-1' });

            await payoutService.processCycleEnd('g1');

            expect(mockSorobanPayout).toHaveBeenCalled();
        });

        it('warns defaulters and the creator instead of paying out when contributions are missing', async () => {
            const group = {
                id: 'g1',
                name: 'Ajo Circle',
                contributionAmount: 10,
                currentPayoutIndex: 0,
                totalCycles: 0,
                currentCycleStart: null,
                currentCycleEnd: null,
                payoutOrder: ['u1', 'u2'],
                members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER')],
            };
            prisma.savingsGroup.findUnique.mockResolvedValue(group);
            prisma.contribution.findMany.mockResolvedValue([{ userId: 'u1', status: 'COMPLETED' }]);

            await payoutService.processCycleEnd('g1');

            expect(mockSorobanPayout).not.toHaveBeenCalled();
            // Warns the defaulting member (u2) and prompts the creator (u1) for a decision
            expect(mockSendMessage).toHaveBeenCalledWith('+1u2', expect.stringContaining('Final warning'));
            expect(mockSendMessage).toHaveBeenCalledWith('+1u1', expect.stringContaining('PAYOUT WAIT'));
        });
    });

    describe('full rotation integration', () => {
        it('runs a full 5-member Ajo cycle: 5 payouts then a cycle reset', async () => {
            const memberIds = ['u1', 'u2', 'u3', 'u4', 'u5'];
            const members = memberIds.map((id, i) => makeMember(id, i === 0 ? 'CREATOR' : 'MEMBER'));

            // Simulated mutable group state, mirroring what Postgres would hold across payouts.
            let state = {
                id: 'g1',
                name: 'Ajo Circle',
                contributionAmount: 10,
                currentPayoutIndex: 0,
                totalCycles: 0,
                payoutOrder: memberIds,
                members,
            };

            prisma.savingsGroup.update.mockImplementation(({ data }: any) => {
                state = { ...state, ...data };
                return Promise.resolve(state);
            });

            for (let i = 0; i < 5; i++) {
                prisma.savingsGroup.findUnique.mockResolvedValueOnce({ ...state, members });
                prisma.payout.findFirst.mockResolvedValueOnce(null);
                prisma.payout.create.mockResolvedValueOnce({ id: `payout-${i}`, recipientId: memberIds[i] });
                if (i === 4) {
                    // completeCycle's own lookup after the 5th payout
                    prisma.savingsGroup.findUnique.mockResolvedValueOnce({ ...state, currentPayoutIndex: 5, members });
                }

                await payoutService.executePayout('g1');
            }

            expect(mockSorobanPayout).toHaveBeenCalledTimes(5);
            memberIds.forEach((id) => {
                expect(mockSorobanPayout).toHaveBeenCalledWith('TEST_TREASURY_SECRET', `PUB_${id}`, '50');
            });
            expect(mockSorobanResetCycle).toHaveBeenCalledTimes(1);
            expect(state.totalCycles).toBe(1);
            expect(state.currentPayoutIndex).toBe(0);
        });
    });
});
