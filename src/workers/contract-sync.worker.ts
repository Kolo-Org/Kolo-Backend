/**
 * Contract-Sync Reconciliation Worker
 *
 * Runs every 5 minutes.  For every active SavingsGroup that has a deployed
 * Soroban contract, it:
 *   1. Fetches each member's on-chain contribution via get_contribution().
 *   2. Sums the COMPLETED Contribution records in the current DB cycle.
 *   3. Flags any divergence as a ReconciliationMismatch record.
 *   4. Does NOT auto-fix — mismatches require admin review.
 *
 * Crash-recovery idempotency: if the backend crashed after on-chain confirmation
 * but before the DB write, this worker will detect that the on-chain amount is
 * higher than the DB total and log a RECONCILIATION_MISMATCH event so an admin
 * can resolve it by writing the missing DB record.
 */
import { Worker, Job } from 'bullmq';
import { PrismaClient, Prisma } from '@prisma/client';
import { config } from '../config/env';
import { SorobanService } from '../services/soroban.service';
import { observabilityService } from '../services/observability.service';
import { scheduleReconciliation, getContractSyncQueue } from '../queue/contract-sync.queue';
import { applyEncryptionMiddleware } from '../middleware/prisma-encryption.middleware';

const prisma = new PrismaClient();
applyEncryptionMiddleware(prisma);
const connection = { url: config.REDIS_URL };

let workerInstance: Worker | null = null;

export function startContractSyncWorker(): void {
    if (workerInstance) return;

    const sorobanService = new SorobanService();

    workerInstance = new Worker(
        'contract-sync',
        async (job: Job) => {
            if (job.name !== 'reconcile') return;
            console.log(`[ContractSyncWorker] Starting reconciliation run (job ${job.id})`);
            await runReconciliation(sorobanService);
        },
        {
            connection,
            concurrency: 1, // reconciliation must run serially to avoid duplicate mismatch records
        },
    );

    workerInstance.on('completed', (job) => {
        console.log(`[ContractSyncWorker] Reconciliation job ${job.id} completed`);
    });

    workerInstance.on('failed', (job, err) => {
        console.error(`[ContractSyncWorker] Reconciliation job ${job?.id} failed:`, err.message);
    });

    // Register the 5-minute repeating schedule
    scheduleReconciliation().catch((err) =>
        console.error('[ContractSyncWorker] Failed to schedule reconciliation:', err),
    );

    console.log('[ContractSyncWorker] Started — reconciliation scheduled every 5 minutes');
}

/**
 * Core reconciliation logic.  Separated from the BullMQ callback so it can be
 * called directly from tests.
 */
export async function runReconciliation(sorobanService: SorobanService): Promise<ReconciliationSummary> {
    const summary: ReconciliationSummary = { groupsScanned: 0, membersChecked: 0, mismatchesFound: 0, errors: [] };

    // Only scan groups that have a fully deployed Soroban contract
    const groups = await prisma.savingsGroup.findMany({
        where: {
            deploymentStatus: 'DEPLOYED',
            stellarContractId: { not: null },
        },
        include: {
            members: {
                include: { user: true },
            },
        },
    });

    summary.groupsScanned = groups.length;

    for (const group of groups) {
        const contractId = group.stellarContractId!;

        // Determine the current cycle window for DB lookups.
        // Fall back to the beginning of time if no cycle has started yet.
        const cycleStart = group.currentCycleStart ?? new Date(0);
        const cycleEnd = group.currentCycleEnd ?? new Date();

        for (const membership of group.members) {
            const member = membership.user;
            summary.membersChecked++;

            if (!member.stellarWallet) continue;

            let memberPublicKey: string;
            try {
                const wallet = JSON.parse(member.stellarWallet as string);
                memberPublicKey = wallet.publicKey;
            } catch {
                summary.errors.push(`[group=${group.id}] Could not parse wallet for user ${member.id}`);
                continue;
            }

            // 1. Query on-chain contribution (returns stroops as bigint)
            let onChainStroops: bigint;
            try {
                onChainStroops = await sorobanService.queryContribution(contractId, memberPublicKey);
            } catch (err: any) {
                summary.errors.push(
                    `[group=${group.id}] queryContribution failed for user ${member.id}: ${err.message}`,
                );
                observabilityService.logError('ReconciliationWorker: queryContribution error', err, {
                    groupId: group.id,
                    userId: member.id,
                });
                continue;
            }

            // 2. Sum COMPLETED DB contributions for this member in the current cycle
            const dbContributions = await prisma.contribution.findMany({
                where: {
                    userId: member.id,
                    groupId: group.id,
                    status: 'COMPLETED',
                    createdAt: { gte: cycleStart, lte: cycleEnd },
                },
            });

            const dbTotalXlm = dbContributions.reduce(
                (acc, c) => acc + Number(c.amount),
                0,
            );
            // Convert DB amount (XLM) to stroops for comparison
            const dbStroops = BigInt(Math.round(dbTotalXlm * 10_000_000));

            // 3. Compare — allow a 1-stroop tolerance for floating-point rounding
            if (onChainStroops === dbStroops || Math.abs(Number(onChainStroops - dbStroops)) <= 1) {
                continue; // ✅ in sync
            }

            // 4. Mismatch detected — log for admin review, do NOT auto-fix
            summary.mismatchesFound++;

            const onChainXlm = new Prisma.Decimal(Number(onChainStroops) / 10_000_000);
            const dbXlm = new Prisma.Decimal(dbTotalXlm);

            await prisma.reconciliationMismatch.create({
                data: {
                    groupId: group.id,
                    userId: member.id,
                    onChainAmount: onChainXlm,
                    dbAmount: dbXlm,
                },
            });

            observabilityService.logError(
                'RECONCILIATION_MISMATCH',
                new Error('On-chain contribution amount does not match DB total'),
                {
                    groupId: group.id,
                    userId: member.id,
                    onChainXlm: onChainXlm.toString(),
                    dbXlm: dbXlm.toString(),
                    deltaSproops: (onChainStroops - dbStroops).toString(),
                },
            );
        }
    }

    observabilityService.logInfo('[ContractSyncWorker] Reconciliation run complete', {
        groupsScanned: summary.groupsScanned,
        membersChecked: summary.membersChecked,
        mismatchesFound: summary.mismatchesFound,
        errors: summary.errors.length,
    });

    return summary;
}

export interface ReconciliationSummary {
    groupsScanned: number;
    membersChecked: number;
    mismatchesFound: number;
    errors: string[];
}

export async function closeContractSyncWorker(): Promise<void> {
    if (workerInstance) {
        await workerInstance.close();
        workerInstance = null;
    }
}
