import { BotController } from '../controllers/bot.controller';
import { Request, Response } from 'express';

const mockEnqueueMessage = jest.fn().mockResolvedValue({ id: 'mock-job-id' });

jest.mock('../queue/message.queue', () => ({
    enqueueMessage: (...args: any[]) => mockEnqueueMessage(...args),
}));

jest.mock('../config/env', () => ({
    config: { VERIFY_TOKEN: 'test_token' },
}));

describe('BotController', () => {
    let botController: BotController;
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;

    beforeEach(() => {
        jest.clearAllMocks();
        botController = new BotController();
        mockRes = { sendStatus: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
    });

    const createWebhookPayload = (text: string) => ({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { metadata: { phone_number_id: '123' }, messages: [{ from: '12345', text: { body: text } }] } }] }],
    });

    describe('verifyWebhook', () => {
        it('should return challenge for valid verify token', () => {
            mockReq = {
                query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'test_token', 'hub.challenge': '12345_challenge' },
            };
            process.env.VERIFY_TOKEN = 'test_token';
            botController.verifyWebhook(mockReq as Request, mockRes as Response);
            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.send).toHaveBeenCalledWith('12345_challenge');
        });

        it('should send empty challenge when challenge param is missing', () => {
            mockReq = {
                query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'test_token' },
            };
            botController.verifyWebhook(mockReq as Request, mockRes as Response);
            expect(mockRes.status).toHaveBeenCalledWith(200);
            expect(mockRes.send).toHaveBeenCalledWith('');
        });

        it('should return 403 for invalid verify token', () => {
            mockReq = {
                query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong_token', 'hub.challenge': '12345_challenge' },
            };
            process.env.VERIFY_TOKEN = 'test_token';
            botController.verifyWebhook(mockReq as Request, mockRes as Response);
            expect(mockRes.sendStatus).toHaveBeenCalledWith(403);
        });

        it('should return 400 for missing params', () => {
            mockReq = { query: {} };
            botController.verifyWebhook(mockReq as Request, mockRes as Response);
            expect(mockRes.sendStatus).toHaveBeenCalledWith(400);
        });
    });

    describe('handleMessage', () => {
        it('should return 200 immediately and enqueue job for valid payload', async () => {
            mockReq = { body: createWebhookPayload('SEND 10 @jane') };
            await botController.handleMessage(mockReq as Request, mockRes as Response);
            expect(mockRes.sendStatus).toHaveBeenCalledWith(200);
            expect(mockEnqueueMessage).toHaveBeenCalledWith({
                from: '12345',
                msgBody: 'SEND 10 @jane',
                messageTimestamp: expect.any(Number),
            });
        });

        it('should return 200 and not enqueue for empty message body', async () => {
            const payload = createWebhookPayload('');
            payload.entry[0].changes[0].value.messages[0].text.body = '';
            mockReq = { body: payload };
            await botController.handleMessage(mockReq as Request, mockRes as Response);
            expect(mockRes.sendStatus).toHaveBeenCalledWith(200);
            expect(mockEnqueueMessage).not.toHaveBeenCalled();
        });

        it('should return 200 even without messages array', async () => {
            mockReq = { body: { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {} }] }] } };
            await botController.handleMessage(mockReq as Request, mockRes as Response);
            expect(mockRes.sendStatus).toHaveBeenCalledWith(200);
            expect(mockEnqueueMessage).not.toHaveBeenCalled();
        });

        it('should return 404 for non-object payloads', async () => {
            mockReq = { body: {} };
            await botController.handleMessage(mockReq as Request, mockRes as Response);
            expect(mockRes.sendStatus).toHaveBeenCalledWith(404);
            expect(mockEnqueueMessage).not.toHaveBeenCalled();
        });

        it('should return 404 for missing body', async () => {
            mockReq = {};
            await botController.handleMessage(mockReq as Request, mockRes as Response);
            expect(mockRes.sendStatus).toHaveBeenCalledWith(404);
            expect(mockEnqueueMessage).not.toHaveBeenCalled();
        });

        it.each([
            ['an Error', new Error('redis down')],
            ['a string', 'redis down'],
            ['a non-error value', { code: 500 }],
        ])('should still return 200 when enqueue rejects with %s', async (_label, reason) => {
            mockEnqueueMessage.mockRejectedValueOnce(reason);
            mockReq = { body: createWebhookPayload('BALANCE') };
            await botController.handleMessage(mockReq as Request, mockRes as Response);
            expect(mockRes.sendStatus).toHaveBeenCalledWith(200);
            expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
        });
    });
});
