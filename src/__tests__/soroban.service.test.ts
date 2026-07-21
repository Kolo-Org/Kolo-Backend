import { SorobanService } from '../services/soroban.service';

describe('SorobanService', () => {
    describe('payout', () => {
        it('delegates to the Stellar payment rail and returns the transaction hash', async () => {
            const mockSendPayment = jest.fn().mockResolvedValue({ hash: 'tx_abc', successful: true });
            const sorobanService = new SorobanService({ sendPayment: mockSendPayment } as any);

            const result = await sorobanService.payout('SECRET', 'PUB_RECIPIENT', '50');

            expect(mockSendPayment).toHaveBeenCalledWith('SECRET', 'PUB_RECIPIENT', '50');
            expect(result).toEqual({ hash: 'tx_abc' });
        });
    });

    describe('resetCycle', () => {
        it('resolves without throwing (no on-chain rotation contract deployed yet)', async () => {
            const sorobanService = new SorobanService({ sendPayment: jest.fn() } as any);
            await expect(sorobanService.resetCycle('g1')).resolves.toBeUndefined();
        });
    });
});
