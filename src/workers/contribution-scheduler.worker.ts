import { Worker, Job } from 'bullmq';
import { config } from '../config/env';
import { PrismaClient } from '@prisma/client';
import { WhatsAppService } from '../services/whatsapp.service';
import { PayoutService } from '../services/payout.service';
import { enqueueDelayedReminder, enqueueCycleEnd } from '../queue/contribution-scheduler.queue';
import { redisClient } from '../lib/redis';

const prisma = new PrismaClient();
const connection = { url: config.REDIS_URL };

let workerInstance: Worker | null = null;

export function startContributionSchedulerWorker(): void {
    if (workerInstance) return;

    const whatsappService = new WhatsAppService();
    const payoutService = new PayoutService();

    workerInstance = new Worker(
        'contribution-scheduling',
        async (job: Job) => {
            console.log(`Processing contribution-scheduling job ${job.id} (${job.name})`);

            try {
                if (job.name === 'cycle-start') {
                    await handleCycleStart(job, whatsappService);
                } else if (job.name === 'last-call-reminder') {
                    await handleLastCallReminder(job, whatsappService);
                } else if (job.name === 'cycle-end') {
                    await handleCycleEnd(job, payoutService);
                }
            } catch (err) {
                console.error(`Error processing job ${job.id}:`, err);
                throw err;
            }
        },
        {
            connection,
            concurrency: 5,
        }
    );

    workerInstance.on('completed', (job) => {
        console.log(`Contribution job ${job.id} completed`);
    });

    workerInstance.on('failed', (job, err) => {
        console.error(`Contribution job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err);
    });

    console.log('Contribution scheduler worker started');
}

async function handleCycleStart(job: Job, whatsappService: WhatsAppService) {
    const { groupId, frequency } = job.data;
    
    // Calculate new currentCycleEnd
    const now = new Date();
    const currentCycleStart = now;
    let currentCycleEnd = new Date(now);
    
    switch (frequency.toUpperCase()) {
        case 'WEEKLY':
            currentCycleEnd.setDate(currentCycleEnd.getDate() + 7);
            break;
        case 'BIWEEKLY':
            currentCycleEnd.setDate(currentCycleEnd.getDate() + 14);
            break;
        case 'MONTHLY':
            currentCycleEnd.setMonth(currentCycleEnd.getMonth() + 1);
            break;
        default:
            currentCycleEnd.setDate(currentCycleEnd.getDate() + 7); // Default to weekly
    }

    // Update group in DB
    const group = await prisma.savingsGroup.update({
        where: { id: groupId },
        data: {
            currentCycleStart,
            currentCycleEnd,
        },
        include: { members: { include: { user: true } } }
    });

    // Schedule delayed reminder (24h before end)
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    const timeUntilEnd = currentCycleEnd.getTime() - currentCycleStart.getTime();
    
    if (timeUntilEnd > twentyFourHoursMs) {
        await enqueueDelayedReminder(groupId, timeUntilEnd - twentyFourHoursMs);
    }
    
    // Schedule cycle end to advance the cycle and trigger payouts
    await enqueueCycleEnd(groupId, timeUntilEnd);

    // Initial reminder - nobody has contributed yet in this new cycle
    for (const member of group.members) {
        if (!member.user.phoneNumber) continue;
        
        const message = `A new cycle for ${group.name} has started! Please contribute your required amount of ${group.contributionAmount} XLM by ${currentCycleEnd.toDateString()}.`;
        
        try {
            await whatsappService.sendMessage(member.user.phoneNumber, message);
        } catch (e) {
            console.error(`Failed to send initial reminder to ${member.user.phoneNumber}`);
        }
    }
}

async function handleLastCallReminder(job: Job, whatsappService: WhatsAppService) {
    const { groupId } = job.data;
    
    const group = await prisma.savingsGroup.findUnique({
        where: { id: groupId },
        include: { members: { include: { user: true } } }
    });
    
    if (!group || !group.currentCycleStart || !group.currentCycleEnd) return;
    
    // We create a cycle ID conceptually using the start time
    const cycleId = group.currentCycleStart.getTime().toString();
    
    // Find all contributions for the current cycle
    const contributions = await prisma.contribution.findMany({
        where: {
            groupId,
            createdAt: {
                gte: group.currentCycleStart,
                lt: group.currentCycleEnd
            },
            status: 'COMPLETED'
        }
    });
    
    const contributingUserIds = new Set(contributions.map(c => c.userId));
    
    for (const member of group.members) {
        if (!member.user.phoneNumber) continue;
        
        // Check if member has contributed
        if (contributingUserIds.has(member.userId)) continue;
        
        // Idempotency check via Redis
        const dedupKey = `reminder:${groupId}:${cycleId}:${member.userId}`;
        
        // Set with NX (only if not exists), EX (expire in seconds). Let's say 48 hours to be safe.
        const acquired = await redisClient.set(dedupKey, '1', 'EX', 48 * 60 * 60, 'NX');
        
        if (acquired === 'OK') {
            const message = `🚨 Last call reminder! Please contribute your required amount of ${group.contributionAmount} XLM for ${group.name} by ${group.currentCycleEnd.toDateString()}.`;
            try {
                await whatsappService.sendMessage(member.user.phoneNumber, message);
            } catch (e) {
                console.error(`Failed to send last call reminder to ${member.user.phoneNumber}`);
                // If it failed, delete the key so we can retry
                await redisClient.del(dedupKey);
            }
        }
    }
}

async function handleCycleEnd(job: Job, payoutService: PayoutService) {
    const { groupId } = job.data;
    const group = await prisma.savingsGroup.findUnique({ where: { id: groupId } });
    if (!group) return;

    // The cycle has officially ended. Verify contributions and pay out the next member in rotation.
    await payoutService.processCycleEnd(groupId);
}

export async function closeContributionWorker(): Promise<void> {
    if (workerInstance) {
        await workerInstance.close();
        workerInstance = null;
    }
}
