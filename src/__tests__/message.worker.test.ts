const mockProcessCommand = jest.fn();
const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn();
const mockWorkerInstance: Record<string, any> = { on: mockWorkerOn, close: mockWorkerClose };

const mockWorkerConstructor = jest.fn().mockImplementation(
    (_queueName: string, callback: (job: any) => Promise<void>, _opts: any) => {
        mockWorkerInstance.callback = callback;
        return mockWorkerInstance;
    },
);

jest.mock('bullmq', () => ({
    Worker: mockWorkerConstructor,
}));

jest.mock('../services/message-processor.service', () => ({
    MessageProcessor: jest.fn().mockImplementation(() => ({
        processCommand: mockProcessCommand,
    })),
}));

import { startWorker, closeWorker } from '../workers/message.worker';

describe('MessageWorker', () => {
    beforeEach(async () => {
        await closeWorker();
        jest.clearAllMocks();
    });

    it('should create a Worker with correct queue name and options', () => {
        startWorker();
        expect(mockWorkerConstructor).toHaveBeenCalledWith(
            'message-processing',
            expect.any(Function),
            expect.objectContaining({ concurrency: 5 }),
        );
    });

    it('should register completed and failed event handlers', () => {
        startWorker();
        expect(mockWorkerOn).toHaveBeenCalledWith('completed', expect.any(Function));
        expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
    });

    it('should call processCommand when processing a job', async () => {
        startWorker();
        const job = { id: 'job-1', data: { from: '12345', msgBody: 'BALANCE' } };
        await mockWorkerInstance.callback(job);
        expect(mockProcessCommand).toHaveBeenCalledWith('12345', 'BALANCE');
    });

    it('should not start a second worker instance', () => {
        startWorker();
        startWorker();
        expect(mockWorkerConstructor).toHaveBeenCalledTimes(1);
    });

    it('should close the worker', async () => {
        startWorker();
        await closeWorker();
        expect(mockWorkerClose).toHaveBeenCalled();
    });

    it('should handle close when worker not started', async () => {
        await closeWorker();
        expect(mockWorkerClose).not.toHaveBeenCalled();
    });

    it('should handle job failure gracefully', () => {
        startWorker();
        const failedHandler = mockWorkerOn.mock.calls.find((c: any[]) => c[0] === 'failed')?.[1];
        expect(failedHandler).toBeDefined();
        const job = { id: 'job-2', attemptsMade: 2 };
        const err = new Error('Stellar network timeout');
        failedHandler(job, err);
    });

    it('should handle job completion gracefully', () => {
        startWorker();
        const completedHandler = mockWorkerOn.mock.calls.find((c: any[]) => c[0] === 'completed')?.[1];
        expect(completedHandler).toBeDefined();
        const job = { id: 'job-3' };
        completedHandler(job);
    });
});
