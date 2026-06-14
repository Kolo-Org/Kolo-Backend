import { BotController } from '../controllers/bot.controller';
import { Request, Response } from 'express';
jest.mock('../services/whatsapp.service', () => ({
    WhatsAppService: jest.fn().mockImplementation(() => ({
        sendMessage: jest.fn().mockResolvedValue(true)
    }))
}));
jest.mock('../services/stellar.service', () => ({
    StellarService: jest.fn().mockImplementation(() => ({
        checkBalance: jest.fn().mockResolvedValue('100.50'),
        sendPayment: jest.fn().mockResolvedValue({ successful: true, hash: 'tx123' })
    }))
}));
jest.mock('../services/user.service', () => ({
    UserService: jest.fn().mockImplementation(() => ({
        getOrCreateUser: jest.fn().mockResolvedValue({ 
            id: 'u1', phoneNumber: '12345', username: 'john', stellarWallet: 'G_PUB:S_SEC', createdAt: new Date()
        }),
        resolveUser: jest.fn().mockResolvedValue({ 
            id: 'u2', phoneNumber: '67890', username: 'jane', stellarWallet: 'G_PUB2:S_SEC2'
        })
    }))
}));
jest.mock('../services/group.service', () => ({
    GroupService: jest.fn().mockImplementation(() => ({
        createGroup: jest.fn().mockResolvedValue({ id: 'g1' }),
        joinGroup: jest.fn().mockResolvedValue({ id: 'gm1' }),
        getGroupStatus: jest.fn().mockResolvedValue([
            { role: 'CREATOR', groupId: 'g1', group: { name: 'G1', contributionAmount: 10, contributionFrequency: 'MONTHLY', members: [] } }
        ]),
        addContribution: jest.fn().mockResolvedValue({ id: 'c1' })
    }))
}));
jest.mock('../config/env', () => ({
    config: { VERIFY_TOKEN: 'test_token' }
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
        entry: [{ changes: [{ value: { metadata: { phone_number_id: '123' }, messages: [{ from: '12345', text: { body: text } }] } }] }]
    });
    describe('verifyWebhook', () => {
        it('should return challenge for valid verify token', () => {
            mockReq = {
                query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'test_token', 'hub.challenge': '12345_challenge' }
            };
