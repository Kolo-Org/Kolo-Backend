import { MessageProcessor } from '../services/message-processor.service';

const mockSendMessage = jest.fn().mockResolvedValue(true);
const mockCheckBalance = jest.fn().mockResolvedValue('100.50');
const mockSendPayment = jest.fn().mockResolvedValue({ successful: true, hash: 'tx123' });
const mockGetOrCreateUser = jest.fn().mockResolvedValue({
    id: 'u1', phoneNumber: '12345', username: 'john', stellarWallet: 'G_PUB:S_SEC', createdAt: new Date(),
});
const mockResolveUser = jest.fn().mockResolvedValue({
    id: 'u2', phoneNumber: '67890', username: 'jane', stellarWallet: 'G_PUB2:S_SEC2',
});
const mockCreateGroup = jest.fn().mockResolvedValue({ id: 'g1' });
const mockJoinGroup = jest.fn().mockResolvedValue({ id: 'gm1' });
const mockGetGroupStatus = jest.fn().mockResolvedValue([
    { role: 'CREATOR', groupId: 'g1', group: { id: 'g1', name: 'G1', contributionAmount: 10, contributionFrequency: 'MONTHLY', members: [] } },
]);
const mockAddContribution = jest.fn().mockResolvedValue({ id: 'c1' });

const mockWhatsAppService = { sendMessage: mockSendMessage };
const mockStellarService = { checkBalance: mockCheckBalance, sendPayment: mockSendPayment, generateWallet: jest.fn(), fundTestnetAccount: jest.fn() };
const mockUserService = { getOrCreateUser: mockGetOrCreateUser, resolveUser: mockResolveUser };
const mockGroupService = { createGroup: mockCreateGroup, joinGroup: mockJoinGroup, getGroupStatus: mockGetGroupStatus, addContribution: mockAddContribution };

describe('MessageProcessor', () => {
    let processor: MessageProcessor;

    beforeEach(() => {
        jest.clearAllMocks();
        processor = new MessageProcessor(
            mockWhatsAppService as any,
            mockStellarService as any,
            mockUserService as any,
            mockGroupService as any,
        );
    });

    describe('processCommand routing', () => {
        it('should handle BALANCE command', async () => {
            await processor.processCommand('12345', 'BALANCE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('100.50 XLM'));
        });

        it('should handle PROFILE command', async () => {
            await processor.processCommand('12345', 'PROFILE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Kolo Profile'));
        });

        it('should handle HISTORY command', async () => {
            await processor.processCommand('12345', 'HISTORY');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('transaction history'));
        });

        it('should handle HELP command', async () => {
            await processor.processCommand('12345', 'HELP');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Kolo Commands'));
        });

        it('should handle SUPPORT command as alias for HELP', async () => {
            await processor.processCommand('12345', 'SUPPORT');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Kolo Commands'));
        });

        it('should handle UNKNOWN command', async () => {
            await processor.processCommand('12345', 'INVALID_CMD');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining("didn't understand"));
        });

        it('should handle CREATE GROUP command', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Family 100 WEEKLY');
            expect(mockCreateGroup).toHaveBeenCalledWith('u1', 'Family', 100, 'WEEKLY');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Group'));
        });

        it('should handle JOIN GROUP command', async () => {
            await processor.processCommand('12345', 'JOIN GROUP g1');
            expect(mockJoinGroup).toHaveBeenCalledWith('u1', 'g1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('joined'));
        });

        it('should handle INVITE MEMBER command', async () => {
            await processor.processCommand('12345', 'INVITE MEMBER @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('67890', expect.stringContaining('INVITE'));
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Invite sent'));
        });

        it('should handle GROUP STATUS command', async () => {
            await processor.processCommand('12345', 'GROUP STATUS');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Your Groups'));
        });

        it('should handle whitespace-only input as unknown', async () => {
            await processor.processCommand('12345', '   ');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining("didn't understand"));
        });
    });

    describe('handleSend', () => {
        it('should send payment and notify on success', async () => {
            await processor.processCommand('12345', 'SEND 10 @jane');

            expect(mockGetOrCreateUser).toHaveBeenCalledWith('12345');
            expect(mockResolveUser).toHaveBeenCalledWith('@jane');
            expect(mockSendPayment).toHaveBeenCalledWith('S_SEC', 'G_PUB2', '10');

            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Initiating transfer'));
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Successfully sent'));
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'SEND 10');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Usage'));
            expect(mockSendPayment).not.toHaveBeenCalled();
        });

        it('should handle missing sender wallet', async () => {
            mockGetOrCreateUser.mockResolvedValueOnce({
                id: 'u1', phoneNumber: '12345', stellarWallet: null,
            });
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('not configured'));
            expect(mockSendPayment).not.toHaveBeenCalled();
        });

        it('should handle missing recipient wallet', async () => {
            mockResolveUser.mockResolvedValueOnce({
                id: 'u2', phoneNumber: '67890', stellarWallet: null,
            });
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Could not find wallet'));
            expect(mockSendPayment).not.toHaveBeenCalled();
        });

        it('should handle missing recipient entirely', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Could not find wallet'));
            expect(mockSendPayment).not.toHaveBeenCalled();
        });

        it('should handle send payment failure', async () => {
            mockSendPayment.mockRejectedValueOnce(new Error('Insufficient balance'));
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Failed'));
        });
    });

    describe('handleContribute', () => {
        it('should record contribution and notify on success', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE 50');
            expect(mockAddContribution).toHaveBeenCalledWith('u1', 'g1', 50, expect.stringContaining('mock_tx_'));
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Successfully contributed'));
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Usage'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should handle missing group membership', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'CONTRIBUTE 50');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('not part of any group'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should handle contribution failure', async () => {
            mockAddContribution.mockRejectedValueOnce(new Error('Group not found'));
            await processor.processCommand('12345', 'CONTRIBUTE 50');
            expect(mockSendMessage).toHaveBeenLastCalledWith('12345', expect.stringContaining('failed'));
        });
    });

    describe('handleRequest', () => {
        it('should send request to recipient and confirmation to sender', async () => {
            await processor.processCommand('12345', 'REQUEST 25 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('67890', expect.stringContaining('REQUEST'));
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('sent to'));
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'REQUEST 25');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Usage'));
        });

        it('should handle missing recipient', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'REQUEST 25 @ghost');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Could not find user'));
        });
    });

    describe('handleCreateGroup', () => {
        it('should create group with parsed args', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Savings 50 MONTHLY');
            expect(mockCreateGroup).toHaveBeenCalledWith('u1', 'Savings', 50, 'MONTHLY');
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'CREATE GROUP');
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Usage'));
        });

        it('should handle group creation failure', async () => {
            mockCreateGroup.mockRejectedValueOnce(new Error('Name taken'));
            await processor.processCommand('12345', 'CREATE GROUP Savings 50 MONTHLY');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Failed'));
        });
    });

    describe('handleJoinGroup', () => {
        it('should join group', async () => {
            await processor.processCommand('12345', 'JOIN GROUP g1');
            expect(mockJoinGroup).toHaveBeenCalledWith('u1', 'g1');
        });

        it('should show usage when missing groupId', async () => {
            await processor.processCommand('12345', 'JOIN GROUP');
            expect(mockJoinGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Usage'));
        });
    });

    describe('handleInviteMember', () => {
        it('should show usage when missing target', async () => {
            await processor.processCommand('12345', 'INVITE MEMBER');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Usage'));
        });

        it('should handle missing recipient', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'INVITE MEMBER @ghost');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Could not find user'));
        });

        it('should handle user not being a group creator', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'INVITE MEMBER @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('not the creator'));
        });
    });

    describe('handleGroupStatus', () => {
        it('should handle no groups', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'GROUP STATUS');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('not part of any groups'));
        });
    });

    describe('handleWithdraw', () => {
        it('should show usage when missing amount', async () => {
            await processor.processCommand('12345', 'WITHDRAW');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('Usage'));
        });

        it('should handle no group membership', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'WITHDRAW 100');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('not part of any group'));
        });

        it('should confirm withdrawal', async () => {
            await processor.processCommand('12345', 'WITHDRAW 100');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdrew'));
        });
    });

    describe('error handling', () => {
        it('should catch and report errors from handlers', async () => {
            mockGetOrCreateUser.mockRejectedValueOnce(new Error('DB connection failed'));
            await processor.processCommand('12345', 'BALANCE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('An error occurred'));
        });
    });

    describe('handleBalance edge cases', () => {
        it('should handle missing wallet', async () => {
            mockGetOrCreateUser.mockResolvedValueOnce({
                id: 'u1', phoneNumber: '12345', stellarWallet: null,
            });
            await processor.processCommand('12345', 'BALANCE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('not configured'));
        });
    });

    describe('handleContribute edge cases', () => {
        it('should handle NaN amount gracefully', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE abc');
            const addCall = mockAddContribution.mock.calls[0];
            expect(addCall[2]).toBeNaN();
        });
    });
});
