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
