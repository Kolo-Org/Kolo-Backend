import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export class GroupService {
    public async createGroup(userId: string, name: string, amount: string | Prisma.Decimal, frequency: string) {
        return await prisma.savingsGroup.create({
            data: {
                name,
                contributionAmount: amount,
                contributionFrequency: frequency,
                members: {
                    create: {
                        userId: userId,
                        role: 'CREATOR'
                    }
                }
            }
        });
    }

    public async joinGroup(userId: string, groupId: string) {
        return await prisma.groupMember.create({
            data: {
                userId,
                groupId,
                role: 'MEMBER'
            }
        });
    }

    public async getGroupStatus(userId: string) {
        return await prisma.groupMember.findMany({
            where: { userId },
            include: {
                group: {
                    include: { members: { include: { user: true } } }
                }
            }
        });
    }

    public async getMembersByGroup(groupId: string) {
        return await prisma.groupMember.findMany({
            where: { groupId },
            include: { user: true }
        });
    }

    public async addContribution(userId: string, groupId: string, amount: string | Prisma.Decimal, txHash: string) {
        return await prisma.contribution.create({
            data: {
                userId,
                groupId,
                amount,
                transactionHash: txHash,
                status: 'COMPLETED'
            }
        });
    }

    public async getContributionsByUser(userId: string) {
        return await prisma.contribution.findMany({
            where: { userId }
        });
    }

    public async getContributionsByGroup(groupId: string) {
        return await prisma.contribution.findMany({
            where: { groupId }
        });
    }
}
