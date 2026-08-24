import { prisma } from '../lib/prisma';
import { StellarService } from './stellar.service';
import { decrypt } from '../utils/encryption.util';

export const MAX_PENDING_REQUESTS_PER_USER = 5;
const REQUEST_TTL_HOURS = 24;
const CONFIRMATION_WINDOW_SECONDS = 5 * 60;
const RECLAIM_WINDOW_SECONDS = 60 * 60;

/** Error thrown when a payment request cannot be accepted in its current state. */
export class PaymentRequestError extends Error {
    constructor(public code: 'not_found' | 'not_pending' | 'expired' | 'not_responder' | 'insufficient_balance' | 'too_many_pending') {
        super(`Payment request error: ${code}`);
        this.name = 'PaymentRequestError';
    }
}

/**
 * Tracks P2P payment requests and moves funds through a Stellar claimable
 * balance escrow when the respondent accepts:
 * accept → hold (claimable balance) → confirmation window → requester claims.
 */
export class PaymentRequestService {
    private stellarService: StellarService;

    constructor(stellarService?: StellarService) {
        this.stellarService = stellarService ?? new StellarService();
    }

    public async createRequest(requesterId: string, responderId: string, amount: string): Promise<{ id: string; expiresAt: Date }> {
        const pendingCount = await prisma.paymentRequest.count({
            where: { requesterId, status: 'PENDING' },
        });
        if (pendingCount >= MAX_PENDING_REQUESTS_PER_USER) {
            throw new PaymentRequestError('too_many_pending');
        }

        const expiresAt = new Date(Date.now() + REQUEST_TTL_HOURS * 60 * 60 * 1000);
        const request = await prisma.paymentRequest.create({
            data: {
                requesterId,
                responderId,
                amount,
                status: 'PENDING',
                expiresAt,
            },
        });

        return { id: request.id, expiresAt };
    }

    /**
     * Places the escrow hold and schedules the automatic completion. Only the
     * respondent of a still-pending, unexpired request can accept it.
     */
    public async acceptRequest(
        requestId: string,
        respondentPhoneNumber: string,
    ): Promise<{ request: any; balanceId: string; hash: string }> {
        const request = await this.loadForResponder(requestId, respondentPhoneNumber);

        const wallet = this.parseWallet(request.responder.stellarWallet);
        if (!wallet) {
            throw new PaymentRequestError('not_pending');
        }

        // Confirm the respondent can actually cover the amount before locking funds.
        const balance = await this.getNativeBalance(wallet.publicKey);
        if (parseFloat(balance) < parseFloat(String(request.amount))) {
            throw new PaymentRequestError('insufficient_balance');
        }

        const secret = decrypt(wallet.encryptedSecret, wallet.iv, wallet.authTag);
        const { hash, balanceId } = await this.stellarService.createClaimableBalanceWithHold(
            secret,
            request.requester.stellarWallet ? this.parseWallet(request.requester.stellarWallet)?.publicKey ?? '' : '',
            String(request.amount),
            RECLAIM_WINDOW_SECONDS,
        );

        const accepted = await prisma.paymentRequest.update({
            where: { id: request.id },
            data: { status: 'ACCEPTED', balanceId },
        });

        return { request: accepted, balanceId, hash };
    }

    /** Marks a request declined. Only the respondent of a pending request may decline. */
    public async declineRequest(requestId: string, respondentPhoneNumber: string): Promise<any> {
        await this.loadForResponder(requestId, respondentPhoneNumber);

        return prisma.paymentRequest.update({
            where: { id: requestId },
            data: { status: 'DECLINED' },
            include: { requester: true, responder: true },
        });
    }

    /**
     * Called after the confirmation window: the requester claims the held
     * balance, completing the transfer.
     */
    public async completeRequest(requestId: string): Promise<any> {
        const request = await prisma.paymentRequest.findUnique({
            where: { id: requestId },
            include: { requester: true },
        });
        if (!request || request.status !== 'ACCEPTED' || !request.balanceId) {
            return null;
        }

        const wallet = this.parseWallet(request.requester.stellarWallet);
        if (!wallet) return null;

        const secret = decrypt(wallet.encryptedSecret, wallet.iv, wallet.authTag);
        const { hash } = await this.stellarService.claimClaimableBalance(secret, request.balanceId);

        return prisma.paymentRequest.update({
            where: { id: requestId },
            data: { status: 'COMPLETED', transactionHash: hash },
        });
    }

    /** Expires stale pending requests; returns null when nothing changed. */
    public async expireIfPending(requestId: string): Promise<any> {
        const request = await prisma.paymentRequest.findUnique({ where: { id: requestId } });
        if (!request || request.status !== 'PENDING') {
            return null;
        }

        return prisma.paymentRequest.update({
            where: { id: requestId },
            data: { status: 'EXPIRED' },
        });
    }

    private async loadForResponder(requestId: string, respondentPhoneNumber: string) {
        const request = await prisma.paymentRequest.findUnique({
            where: { id: requestId },
            include: { requester: true, responder: true },
        });
        if (!request) throw new PaymentRequestError('not_found');
        if (request.responder.phoneNumber !== respondentPhoneNumber) throw new PaymentRequestError('not_responder');

        if (request.expiresAt.getTime() <= Date.now()) throw new PaymentRequestError('expired');
        if (request.status !== 'PENDING') throw new PaymentRequestError('not_pending');

        return request as any;
    }

    private parseWallet(stellarWallet: string | null): { publicKey: string; encryptedSecret: string; iv: string; authTag: string } | null {
        if (!stellarWallet) return null;
        try {
            return JSON.parse(stellarWallet);
        } catch {
            return null;
        }
    }

    private async getNativeBalance(publicKey: string): Promise<string> {
        const balances = await this.stellarService.checkBalance(publicKey);
        const native = balances.find((b) => b.assetCode === 'XLM');
        return native?.balance ?? '0';
    }
}
