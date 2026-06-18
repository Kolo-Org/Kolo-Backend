import crypto from 'crypto';
import { verifySignature, RequestWithRawBody } from '../middleware/verifySignature';
import { config } from '../config/env';
import { Response, NextFunction } from 'express';

describe('verifySignature Middleware', () => {
    let mockReq: Partial<RequestWithRawBody>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    const testSecret = 'test_secret';
    let originalSecret: string;

    beforeAll(() => {
        originalSecret = config.WHATSAPP_APP_SECRET;
        config.WHATSAPP_APP_SECRET = testSecret;
    });

    afterAll(() => {
        config.WHATSAPP_APP_SECRET = originalSecret;
    });

    beforeEach(() => {
        mockReq = {
            headers: {},
            rawBody: undefined,
        };
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };
        mockNext = jest.fn();
    });

    it('should call next() if the signature is valid', () => {
        const payload = JSON.stringify({ test: 'data' });
        const rawBody = Buffer.from(payload, 'utf8');
        const expectedHash = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');
        const signature = `sha256=${expectedHash}`;

        mockReq.headers = { 'x-hub-signature-256': signature };
        mockReq.rawBody = rawBody;

        verifySignature(mockReq as RequestWithRawBody, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledTimes(1);
        expect(mockRes.status).not.toHaveBeenCalled();
        expect(mockRes.json).not.toHaveBeenCalled();
    });

    it('should return 401 if the signature is missing', () => {
        mockReq.rawBody = Buffer.from('test', 'utf8');

        verifySignature(mockReq as RequestWithRawBody, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Missing signature' });
        expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 500 if the rawBody is missing', () => {
        mockReq.headers = { 'x-hub-signature-256': 'sha256=somehash' };

        verifySignature(mockReq as RequestWithRawBody, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(500);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Raw body missing' });
        expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 if the signature length is invalid', () => {
        mockReq.rawBody = Buffer.from('test', 'utf8');
        mockReq.headers = { 'x-hub-signature-256': 'sha256=tooshort' };

        verifySignature(mockReq as RequestWithRawBody, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid signature length' });
        expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 if the signature is invalid but length matches', () => {
        const payload = JSON.stringify({ test: 'data' });
        const rawBody = Buffer.from(payload, 'utf8');
        const wrongHash = crypto.createHmac('sha256', 'wrong_secret').update(rawBody).digest('hex');
        const signature = `sha256=${wrongHash}`;

        mockReq.headers = { 'x-hub-signature-256': signature };
        mockReq.rawBody = rawBody;

        verifySignature(mockReq as RequestWithRawBody, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
        expect(mockNext).not.toHaveBeenCalled();
    });
});
