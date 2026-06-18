jest.mock('bullmq', () => {
    const mockAdd = jest.fn();
    const mockClose = jest.fn();
    const MockQueue = jest.fn().mockImplementation(() => ({
        add: mockAdd,
        close: mockClose,
    }));
    return {
        Queue: MockQueue,
        mockAdd,
        mockClose,
    };
});

import { enqueueMessage, closeQueue } from '../queue/message.queue';

const { mockAdd, mockClose } = jest.requireMock('bullmq') as {
    mockAdd: jest.Mock;
    mockClose: jest.Mock;
};

describe('MessageQueue', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should enqueue a message and return a job', async () => {
        const expectedJob = { id: 'job-1', data: { from: '12345', msgBody: 'BALANCE' } };
        mockAdd.mockResolvedValue(expectedJob);

        const job = await enqueueMessage({
            from: '12345',
            msgBody: 'BALANCE',
            messageTimestamp: 1000,
        });

        expect(job).toBe(expectedJob);
        expect(mockAdd).toHaveBeenCalledWith(
            'process-message',
            { from: '12345', msgBody: 'BALANCE', messageTimestamp: 1000 },
            expect.objectContaining({ jobId: expect.any(String) })
        );
    });

    it('should generate a deterministic job ID from content', async () => {
        mockAdd.mockResolvedValue({ id: 'job-2' });

        await enqueueMessage({
            from: '12345',
            msgBody: 'BALANCE',
            messageTimestamp: 1000,
        });
        await enqueueMessage({
            from: '12345',
            msgBody: 'BALANCE',
            messageTimestamp: 1000,
        });

        const firstCallId = mockAdd.mock.calls[0][2].jobId;
        const secondCallId = mockAdd.mock.calls[1][2].jobId;
        expect(firstCallId).toBe(secondCallId);
    });

    it('should generate different job IDs for different content', async () => {
        mockAdd.mockResolvedValue({ id: 'job-3' });

        await enqueueMessage({
            from: '12345',
            msgBody: 'BALANCE',
            messageTimestamp: 1000,
        });
        await enqueueMessage({
            from: '67890',
            msgBody: 'HELP',
            messageTimestamp: 2000,
        });

        const firstCallId = mockAdd.mock.calls[0][2].jobId;
        const secondCallId = mockAdd.mock.calls[1][2].jobId;
        expect(firstCallId).not.toBe(secondCallId);
    });

    it('should close the queue', async () => {
        mockAdd.mockResolvedValue({ id: 'job-4' });

        await enqueueMessage({ from: '12345', msgBody: 'TEST', messageTimestamp: 0 });
        await closeQueue();

        expect(mockClose).toHaveBeenCalled();
    });
});
