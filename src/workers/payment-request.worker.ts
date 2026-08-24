import { Worker, Job } from 'bullmq';
import { config } from '../config/env';
import { PrismaClient } from '@prisma/client';
import { WhatsAppService } from '../services/whatsapp.service';
import { PaymentRequestService } from '../services/payment-request.service';
import { t } from '../services/locale.service';
import { redisClient } from '../lib/redis';

export const PAYMENT_REQUEST_QUEUE_NAME = 'payment-request-queue';
export const JOB_COMPLETE_REQUEST = 'complete-request';
export const JOB_EXPIRE_REQUEST = 'expire-request';

const prisma = new PrismaClient();
const connection = { url: config.REDIS_URL };

let workerInstance: Worker | null = null;

export function startPaymentRequestWorker(): void {
    if (workerInstance) return;

    const whatsappService = new WhatsAppService();
    const paymentRequestService = new PaymentRequestService();

    workerInstance = new Worker(
        PAYMENT_REQUEST_QUEUE_NAME,
        async (job: Job) => {
            console.log(`Processing payment-request job ${job.id} (${job.name})`);

            if (job.name === JOB_COMPLETE_REQUEST) {
                await handleCompleteRequest(job, paymentRequestService, whatsappService);
            } else if (job.name === JOB_EXPIRE_REQUEST) {
                await handleExpireRequest(job, paymentRequestService, whatsappService);
            }
        },
        { connection },
    );

    workerInstance.on('failed', (job, err) => {
        console.error(`Payment request job ${job?.id ?? '?'} (${job?.name}) failed:`, err);
    });
}

async function handleCompleteRequest(
    job: Job,
    paymentRequestService: PaymentRequestService,
    whatsappService: WhatsAppService,
): Promise<void> {
    const { requestId } = job.data as { requestId: string };
    const request = await paymentRequestService.completeRequest(requestId);

    // Nothing to do if it was declined/expired during the confirmation window
    // or already completed.
    if (!request) return;

    const requester = await prisma.user.findUnique({ where: { id: request.requesterId } });
    const responder = await prisma.user.findUnique({ where: { id: request.responderId } });

    if (requester?.phoneNumber) {
        await whatsappService.sendMessage(
            requester.phoneNumber,
            t('payment_request.completed_requester', requester.language ?? 'en', {
                amount: String(request.amount),
                asset: request.assetCode,
                hash: request.transactionHash ?? '',
            }),
        );
    }
    if (responder?.phoneNumber) {
        await whatsappService.sendMessage(
            responder.phoneNumber,
            t('payment_request.completed_responder', responder.language ?? 'en', {
                amount: String(request.amount),
                asset: request.assetCode,
            }),
        );
    }
}

async function handleExpireRequest(
    job: Job,
    paymentRequestService: PaymentRequestService,
    whatsappService: WhatsAppService,
): Promise<void> {
    const { requestId } = job.data as { requestId: string };
    const request = await paymentRequestService.expireIfPending(requestId);

    // Only pending requests actually expire; accepted ones are already in escrow.
    if (!request) return;

    const requester = await prisma.user.findUnique({ where: { id: request.requesterId } });
    const responder = await prisma.user.findUnique({ where: { id: request.responderId } });

    if (requester?.phoneNumber && responder?.phoneNumber) {
        const responderHandle = responder.username ? `@${responder.username}` : responder.phoneNumber;
        await whatsappService.sendMessage(
            requester.phoneNumber,
            t('payment_request.expired', requester.language ?? 'en', {
                amount: String(request.amount),
                asset: request.assetCode,
                respondent: responderHandle,
            }),
        );
    }
}
