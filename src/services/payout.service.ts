import { PrismaClient } from '@prisma/client';
import { WhatsAppService } from './whatsapp.service';
import { SorobanService } from './soroban.service';
import { config } from '../config/env';
import { enqueueCycleEnd } from '../queue/contribution-scheduler.queue';

const prisma = new PrismaClient();

export class PayoutOrderLockedError extends Error {
    constructor() {
        super('Payout order is locked for this cycle — the first contribution has already been recorded.');
        this.name = 'PayoutOrderLockedError';
    }
}

export class InvalidPayoutOrderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidPayoutOrderError';
    }
}

export interface CycleContributionStatus {
    group: any;
    order: string[];
    cycleNumber: number;
    contributedUserIds: Set<string>;
    missingUserIds: string[];
    allContributed: boolean;
}

export class PayoutService {
    private whatsappService: WhatsAppService;
    private sorobanService: SorobanService;

    constructor(whatsappService?: WhatsAppService, sorobanService?: SorobanService) {
        this.whatsappService = whatsappService ?? new WhatsAppService();
        this.sorobanService = sorobanService ?? new SorobanService();
    }

    /**
     * Resolves the effective payout order for a group: the explicitly configured
     * order if one has been set, otherwise the order members joined in.
     */
    private resolveOrder(group: any): string[] {
        if (Array.isArray(group.payoutOrder) && group.payoutOrder.length > 0) {
            return group.payoutOrder as string[];
        }
        return group.members.map((m: any) => m.userId);
    }

    public async getEffectivePayoutOrder(groupId: string): Promise<string[]> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { orderBy: { joinedAt: 'asc' } } },
        });
        if (!group) throw new Error('Group not found');
        return this.resolveOrder(group);
    }

    /**
     * Lets the group creator set or reorder the payout rotation. Locked once the
     * first contribution of a cycle has been recorded (see lockOrderForCycle).
     */
    public async setPayoutOrder(groupId: string, requesterUserId: string, order: string[]): Promise<string[]> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: true },
        });
        if (!group) throw new Error('Group not found');

        const requester = group.members.find((m: any) => m.userId === requesterUserId);
        if (!requester || requester.role !== 'CREATOR') {
            throw new Error('Only the group creator can set the payout order.');
        }

        if (group.payoutOrderLockedAt) {
            throw new PayoutOrderLockedError();
        }

        const memberIds = new Set(group.members.map((m: any) => m.userId));
        const orderSet = new Set(order);
        if (orderSet.size !== order.length) {
            throw new InvalidPayoutOrderError('Payout order cannot contain duplicate members.');
        }
        if (orderSet.size !== memberIds.size || [...memberIds].some((id) => !orderSet.has(id))) {
            throw new InvalidPayoutOrderError('Payout order must include every current group member exactly once.');
        }

        const previousOrder = this.resolveOrder(group);

        await prisma.$transaction([
            prisma.savingsGroup.update({
                where: { id: groupId },
                data: { payoutOrder: order },
            }),
            prisma.payoutOrderLog.create({
                data: {
                    groupId,
                    changedBy: requesterUserId,
                    previousOrder,
                    newOrder: order,
                    reason: 'REORDER',
                },
            }),
        ]);

        return order;
    }

    /**
     * Locks in the payout order the moment the first contribution of a cycle
     * lands, so a creator can no longer reshuffle who gets paid after members
     * have already started contributing under the existing order.
     */
    public async lockOrderForCycle(groupId: string): Promise<void> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { orderBy: { joinedAt: 'asc' } } },
        });
        if (!group || group.payoutOrderLockedAt) return;

        await prisma.savingsGroup.update({
            where: { id: groupId },
            data: {
                payoutOrderLockedAt: new Date(),
                payoutOrder: this.resolveOrder(group),
            },
        });
    }

    public async getCycleContributionStatus(groupId: string): Promise<CycleContributionStatus> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { orderBy: { joinedAt: 'asc' }, include: { user: true } } },
        });
        if (!group) throw new Error('Group not found');

        const order = this.resolveOrder(group);
        const cycleNumber = group.totalCycles + 1;

        const cycleWhere: any = { groupId, status: 'COMPLETED' };
        if (group.currentCycleStart) {
            cycleWhere.createdAt = { gte: group.currentCycleStart };
            if (group.currentCycleEnd) {
                cycleWhere.createdAt.lt = group.currentCycleEnd;
            }
        }

        const contributions = await prisma.contribution.findMany({ where: cycleWhere });
        const contributedUserIds = new Set(contributions.map((c) => c.userId));
        const missingUserIds = order.filter((userId) => !contributedUserIds.has(userId));

        return {
            group,
            order,
            cycleNumber,
            contributedUserIds,
            missingUserIds,
            allContributed: missingUserIds.length === 0,
        };
    }

    public async sendFinalWarnings(groupId: string): Promise<void> {
        const status = await this.getCycleContributionStatus(groupId);
        if (status.allContributed) return;

        const membersById = new Map(status.group.members.map((m: any) => [m.userId, m.user]));
        for (const userId of status.missingUserIds) {
            const user: any = membersById.get(userId);
            if (!user?.phoneNumber) continue;
            await this.whatsappService.sendMessage(
                user.phoneNumber,
                `⚠️ Final warning: you haven't contributed to "${status.group.name}" for this cycle yet. Please contribute before the group creator finalizes the payout.`,
            );
        }
    }

    /** Extends the current cycle's contribution deadline by 24h, up to a configured maximum. */
    public async extendDeadline(groupId: string): Promise<Date> {
        const group = await prisma.savingsGroup.findUnique({ where: { id: groupId } });
        if (!group) throw new Error('Group not found');
        if (!group.currentCycleEnd) throw new Error('Group has no active cycle.');

        if (group.deadlineExtensionsUsed >= config.MAX_PAYOUT_DEADLINE_EXTENSIONS) {
            throw new Error(`Maximum deadline extensions (${config.MAX_PAYOUT_DEADLINE_EXTENSIONS}) already used for this cycle.`);
        }

        const newEnd = new Date(group.currentCycleEnd.getTime() + 24 * 60 * 60 * 1000);
        await prisma.savingsGroup.update({
            where: { id: groupId },
            data: {
                currentCycleEnd: newEnd,
                deadlineExtensionsUsed: { increment: 1 },
            },
        });

        await enqueueCycleEnd(groupId, newEnd.getTime() - Date.now());
        await this.notifyAllMembers(groupId, `⏳ The contribution deadline for "${group.name}" has been extended by 24 hours.`);

        return newEnd;
    }

    /** Moves a defaulting member to the back of the rotation and logs the change for audit. */
    public async skipDefaultingMember(groupId: string, requesterUserId: string, defaultingUserId: string): Promise<string[]> {
        const group = await prisma.savingsGroup.findUnique({ where: { id: groupId }, include: { members: true } });
        if (!group) throw new Error('Group not found');

        const requester = group.members.find((m: any) => m.userId === requesterUserId);
        if (!requester || requester.role !== 'CREATOR') {
            throw new Error('Only the group creator can skip a defaulting member.');
        }

        const currentOrder = this.resolveOrder(group);
        if (!currentOrder.includes(defaultingUserId)) {
            throw new InvalidPayoutOrderError('That member is not part of the current payout order.');
        }

        const newOrder = currentOrder.filter((id) => id !== defaultingUserId);
        newOrder.push(defaultingUserId);

        await prisma.$transaction([
            prisma.savingsGroup.update({
                where: { id: groupId },
                data: { payoutOrder: newOrder },
            }),
            prisma.payoutOrderLog.create({
                data: {
                    groupId,
                    changedBy: requesterUserId,
                    previousOrder: currentOrder,
                    newOrder,
                    reason: 'SKIP_DEFAULT',
                },
            }),
        ]);

        return newOrder;
    }

    /** Pays out the reduced pool made up of only the members who actually contributed this cycle. */
    public async proceedWithPartialPool(groupId: string): Promise<any> {
        const status = await this.getCycleContributionStatus(groupId);
        const partialAmount = status.contributedUserIds.size * parseFloat(String(status.group.contributionAmount));
        return this.executePayout(groupId, String(partialAmount));
    }

    public async executePayout(groupId: string, amountOverride?: string): Promise<any> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { orderBy: { joinedAt: 'asc' }, include: { user: true } } },
        });
        if (!group) throw new Error('Group not found');

        const order = this.resolveOrder(group);
        if (order.length === 0) throw new Error('Group has no members to pay out to.');

        const cycleNumber = group.totalCycles + 1;

        // Idempotency: a cycle-end retry or an extended-deadline re-check should
        // never pay the same recipient twice for the same cycle.
        const existingPayout = await prisma.payout.findFirst({ where: { groupId, cycleNumber } });
        if (existingPayout) {
            return existingPayout;
        }

        const recipientUserId = order[group.currentPayoutIndex];
        const recipientMember = group.members.find((m: any) => m.userId === recipientUserId);
        if (!recipientMember?.user?.stellarWallet) {
            throw new Error(`Recipient ${recipientUserId} has no configured wallet; cannot execute payout.`);
        }

        const recipientPublicKey = JSON.parse(recipientMember.user.stellarWallet).publicKey;
        const amount = amountOverride ?? String(parseFloat(String(group.contributionAmount)) * order.length);

        if (!config.GROUP_TREASURY_SECRET) {
            throw new Error('No treasury signer configured — set GROUP_TREASURY_SECRET to enable automatic payouts.');
        }

        const { hash } = await this.sorobanService.payout(config.GROUP_TREASURY_SECRET, recipientPublicKey, amount);

        const payout = await prisma.payout.create({
            data: {
                groupId,
                recipientId: recipientUserId,
                amount,
                transactionHash: hash,
                cycleNumber,
                status: 'COMPLETED',
            },
        });

        const nextIndex = group.currentPayoutIndex + 1;
        await prisma.savingsGroup.update({
            where: { id: groupId },
            data: { currentPayoutIndex: nextIndex },
        });

        const recipientName = recipientMember.user.username ? `@${recipientMember.user.username}` : recipientMember.user.phoneNumber;
        await this.notifyAllMembers(groupId, `💸 ${recipientName} has received their payout of ${amount} USDC`);

        if (nextIndex >= order.length) {
            await this.completeCycle(groupId);
        }

        return payout;
    }

    public async completeCycle(groupId: string): Promise<void> {
        const group = await prisma.savingsGroup.findUnique({ where: { id: groupId } });
        if (!group) throw new Error('Group not found');

        await this.sorobanService.resetCycle(groupId);

        const newTotalCycles = group.totalCycles + 1;
        await prisma.savingsGroup.update({
            where: { id: groupId },
            data: {
                totalCycles: newTotalCycles,
                currentPayoutIndex: 0,
                deadlineExtensionsUsed: 0,
                payoutOrderLockedAt: null,
            },
        });

        await this.notifyAllMembers(groupId, `🎉 Cycle ${newTotalCycles} complete! A new rotation begins.`);
    }

    /**
     * Entry point called when a group's contribution cycle ends. Pays out
     * automatically if every member contributed; otherwise warns defaulters and
     * asks the creator to choose WAIT, PROCEED, or SKIP.
     */
    public async processCycleEnd(groupId: string): Promise<void> {
        const status = await this.getCycleContributionStatus(groupId);

        if (status.allContributed) {
            await this.executePayout(groupId);
            return;
        }

        await this.sendFinalWarnings(groupId);

        const creator = status.group.members.find((m: any) => m.role === 'CREATOR');
        if (creator?.user?.phoneNumber) {
            await this.whatsappService.sendMessage(
                creator.user.phoneNumber,
                `⚠️ Not everyone has contributed to "${status.group.name}" this cycle. Reply with:\n` +
                `PAYOUT WAIT — extend the deadline by 24h\n` +
                `PAYOUT PROCEED — pay out with the partial pool\n` +
                `PAYOUT SKIP <phone or @username> — skip the defaulting member and reorder`,
            );
        }
    }

    private async notifyAllMembers(groupId: string, message: string): Promise<void> {
        const members = await prisma.groupMember.findMany({ where: { groupId }, include: { user: true } });
        for (const member of members) {
            if (!member.user?.phoneNumber) continue;
            try {
                await this.whatsappService.sendMessage(member.user.phoneNumber, message);
            } catch (e) {
                console.error(`Failed to notify ${member.user.phoneNumber}`, e);
            }
        }
    }
}
