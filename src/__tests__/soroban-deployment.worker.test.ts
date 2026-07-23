jest.mock('../lib/redis', () => ({
    redisClient: {
        status: 'ready',
        scan: jest.fn(),
        del: jest.fn(),
        get: jest.fn(),
        set: jest.fn(),
    },
}));

jest.mock('bullmq', () => ({
    Queue: jest.fn().mockImplementation(() => ({
        add: jest.fn().mockResolvedValue({ id: 'job-1' }),
        close: jest.fn().mockResolvedValue(undefined),
    })),
    Worker: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
    })),
}));

// savingsGroup mocks are assigned here so they are accessible from test bodies
const mockFindMany = jest.fn();
const mockUpdate = jest.fn();
const mockFindUnique = jest.fn();

jest.mock('@prisma/client', () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({
        savingsGroup: {
            findMany: (...args: any[]) => mockFindMany(...args),
            update: (...args: any[]) => mockUpdate(...args),
            findUnique: (...args: any[]) => mockFindUnique(...args),
        },
    })),
}));

import { enqueueContractDeployment, getFailedDeployments, retryFailedDeployment } from '../queue/soroban-deployment.queue';

describe('Soroban Deployment Queue & DLQ Unit Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('enqueueContractDeployment should add job to queue', async () => {
        const job = await enqueueContractDeployment('group-123');
        expect(job).toBeDefined();
    });

    it('getFailedDeployments should query Prisma for FAILED status groups', async () => {
        mockFindMany.mockResolvedValue([
            { id: 'group-failed', name: 'Failed Group', deploymentStatus: 'FAILED', deploymentError: 'Timeout' },
        ]);

        const failed = await getFailedDeployments();
        expect(failed).toHaveLength(1);
        expect(failed[0].id).toBe('group-failed');
        expect(mockFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { deploymentStatus: 'FAILED' } })
        );
    });

    it('retryFailedDeployment should reset deploymentStatus to PENDING and enqueue job', async () => {
        mockUpdate.mockResolvedValue({
            id: 'group-failed',
            deploymentStatus: 'PENDING',
            deploymentError: null,
        });

        const job = await retryFailedDeployment('group-failed');
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: 'group-failed' },
            data: {
                deploymentStatus: 'PENDING',
                deploymentError: null,
            },
        });
        expect(job).toBeDefined();
    });
});
