import { GroupService } from '../services/group.service';
import { PrismaClient } from '@prisma/client';

jest.mock('@prisma/client', () => {
  const mPrismaClient = {
    savingsGroup: {
      create: jest.fn(),
    },
    groupMember: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    contribution: {
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mPrismaClient) };
});

describe('GroupService', () => {
  let groupService: GroupService;
  let prismaClientMock: any;

  beforeEach(() => {
    jest.clearAllMocks();
    groupService = new GroupService();
    prismaClientMock = new PrismaClient();
  });

  describe('createGroup', () => {
    it('should create a savings group and add the creator as a member', async () => {
      const mockGroup = { id: 'g1', name: 'Test Group' };
      prismaClientMock.savingsGroup.create.mockResolvedValueOnce(mockGroup);

      const result = await groupService.createGroup('u1', 'Test Group', '100', 'WEEKLY');

      expect(prismaClientMock.savingsGroup.create).toHaveBeenCalledWith({
        data: {
          name: 'Test Group',
          contributionAmount: '100',
          contributionFrequency: 'WEEKLY',
          members: {
            create: {
              userId: 'u1',
              role: 'CREATOR',
            },
          },
        },
      });
      expect(result).toEqual(mockGroup);
    });
  });

  describe('joinGroup', () => {
    it('should create a group member relationship', async () => {
      const mockMember = { id: 'm1', userId: 'u1', groupId: 'g1' };
      prismaClientMock.groupMember.create.mockResolvedValueOnce(mockMember);

      const result = await groupService.joinGroup('u1', 'g1');

      expect(prismaClientMock.groupMember.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          groupId: 'g1',
          role: 'MEMBER',
        },
      });
      expect(result).toEqual(mockMember);
    });
  });

  describe('getGroupStatus', () => {
    it('should return memberships for a given user', async () => {
      const mockMemberships = [{ id: 'm1', group: { name: 'G1' } }];
      prismaClientMock.groupMember.findMany.mockResolvedValueOnce(mockMemberships);

      const result = await groupService.getGroupStatus('u1');

      expect(prismaClientMock.groupMember.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        include: {
          group: {
            include: { members: { include: { user: true } } },
          },
        },
      });
      expect(result).toEqual(mockMemberships);
    });
  });

  describe('addContribution', () => {
    it('should log a new contribution', async () => {
      const mockContribution = { id: 'c1', amount: 50 };
      prismaClientMock.contribution.create.mockResolvedValueOnce(mockContribution);

      const result = await groupService.addContribution('u1', 'g1', '50', 'hash123');

      expect(prismaClientMock.contribution.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          groupId: 'g1',
          amount: '50',
          transactionHash: 'hash123',
          status: 'COMPLETED',
        },
      });
      expect(result).toEqual(mockContribution);
    });
  });
});
