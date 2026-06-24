import { MessageProcessor } from '../services/message-processor.service';

// Mock locale.service so tests never depend on i18next initialisation.
// t() returns "<key>|<serialised-params>" making assertions precise and language-agnostic.
jest.mock('../services/locale.service', () => ({
    t: (key: string, _lang: string, params?: Record<string, string | number>) => {
        const paramStr = params ? '|' + JSON.stringify(params) : '';
        return `${key}${paramStr}`;
    },
}));

const mockSendMessage = jest.fn().mockResolvedValue(true);
const mockCheckBalance = jest.fn().mockResolvedValue('100.50');
const mockSendPayment = jest.fn().mockResolvedValue({ successful: true, hash: 'tx123' });
const mockDecrypt = jest.fn().mockReturnValue('S_SEC');
const mockGetOrCreateUser = jest.fn().mockResolvedValue({
    id: 'u1', phoneNumber: '12345', username: 'john',
    stellarWallet: JSON.stringify({ publicKey: 'G_PUB', encryptedSecret: 'ENC_SEC', iv: 'IV', authTag: 'TAG' }),
    createdAt: new Date(),
});
const mockResolveUser = jest.fn().mockResolvedValue({
    id: 'u2', phoneNumber: '67890', username: 'jane',
    stellarWallet: JSON.stringify({ publicKey: 'G_PUB2', encryptedSecret: 'ENC_SEC2', iv: 'IV2', authTag: 'TAG2' }),
});
const mockCreateGroup = jest.fn().mockResolvedValue({ id: 'g1' });
const mockJoinGroup = jest.fn().mockResolvedValue({ id: 'gm1' });
// Group requires 10 XLM per contribution cycle
const mockGetGroupStatus = jest.fn().mockResolvedValue([
    { role: 'CREATOR', groupId: 'g1', group: { id: 'g1', name: 'G1', contributionAmount: 10, contributionFrequency: 'MONTHLY', members: [] } },
]);
const mockAddContribution = jest.fn().mockResolvedValue({ id: 'c1' });

jest.mock('../utils/encryption.util', () => ({
    decrypt: (...args: any[]) => mockDecrypt(...args),
}));

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
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('balance.success'));
        });

        it('should handle PROFILE command', async () => {
            await processor.processCommand('12345', 'PROFILE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('profile.card'));
        });

        it('should handle HISTORY command', async () => {
            await processor.processCommand('12345', 'HISTORY');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('history.fetching'));
        });

        it('should handle HELP command', async () => {
            await processor.processCommand('12345', 'HELP');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('help.text'));
        });

        it('should handle UNKNOWN command', async () => {
            await processor.processCommand('12345', 'INVALID');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('unknown.command'));
        });

        it('should handle CREATE GROUP command', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Family 100 WEEKLY');
            expect(mockCreateGroup).toHaveBeenCalledWith('u1', 'Family', '100', 'WEEKLY');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('create_group.success'));
        });

        it('should handle JOIN GROUP command', async () => {
            await processor.processCommand('12345', 'JOIN GROUP g1');
            expect(mockJoinGroup).toHaveBeenCalledWith('u1', 'g1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('join_group.success'));
        });

        it('should handle INVITE MEMBER command', async () => {
            await processor.processCommand('12345', 'INVITE MEMBER 0987654321');
            expect(mockResolveUser).toHaveBeenCalledWith('0987654321');
            expect(mockGetGroupStatus).toHaveBeenCalledWith('u1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('invite_member.success'));
            expect(mockSendMessage).toHaveBeenCalledWith('67890', expect.stringContaining('invite_member.notify_recipient'));
        });

        it('should handle GROUP STATUS command', async () => {
            await processor.processCommand('12345', 'GROUP STATUS');
            expect(mockGetGroupStatus).toHaveBeenCalledWith('u1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('group_status.header'));
        });
    });

    describe('handleSend', () => {
        it('should require amount and target', async () => {
            await processor.processCommand('12345', 'SEND');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.usage'));
        });

        it('should decrypt sender secret and send payment on success', async () => {
            await processor.processCommand('12345', 'SEND 10 @jane');

            expect(mockGetOrCreateUser).toHaveBeenCalledWith('12345');
            expect(mockResolveUser).toHaveBeenCalledWith('@jane');
            expect(mockDecrypt).toHaveBeenCalledWith('ENC_SEC', 'IV', 'TAG');
            expect(mockSendPayment).toHaveBeenCalledWith('S_SEC', 'G_PUB2', '10');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.initiating'));
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.success'));
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'SEND 10');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.usage'));
        });

        it('should validate amount format', async () => {
            await processor.processCommand('12345', 'SEND abc @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
        });

        it('should check if sender has a wallet', async () => {
            mockGetOrCreateUser.mockResolvedValueOnce({ id: 'u1', language: 'en' });
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.no_wallet'));
        });

        it('should check if recipient exists and has a wallet', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.no_recipient'));
        });

        it('should handle missing recipient wallet', async () => {
            mockResolveUser.mockResolvedValueOnce({
                id: 'u2', phoneNumber: '67890', stellarWallet: null, language: 'en',
            });
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.no_recipient'));
            expect(mockSendPayment).not.toHaveBeenCalled();
        });

        it('should handle missing recipient entirely', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.no_recipient'));
            expect(mockSendPayment).not.toHaveBeenCalled();
        });

        it('should handle send payment failure', async () => {
            mockSendPayment.mockRejectedValueOnce(new Error('Insufficient balance'));
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.failed'));
        });
    });

    describe('handleContribute', () => {
        it('should record contribution and notify on success when amount matches group requirement', async () => {
            // Group requires 10 XLM (see mockGetGroupStatus above)
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockAddContribution).toHaveBeenCalledWith('u1', 'g1', '10', expect.stringContaining('mock_tx_'));
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.success'));
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.usage'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should handle missing group membership', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.no_group'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should handle contribution failure', async () => {
            mockAddContribution.mockRejectedValueOnce(new Error('Group not found'));
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockSendMessage).toHaveBeenLastCalledWith('12345', expect.stringContaining('contribute.failed'));
        });
    });

    describe('handleContribute amount validation', () => {
        it('should reject a non-numeric amount', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE abc');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should reject zero amount', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE 0');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.zero_amount'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should reject a negative amount', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE -5');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should reject amount with more than 7 decimal places', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE 10.12345678');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.precision_exceeded'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should reject amount exceeding 1,000,000 XLM', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE 1000001');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.exceeds_max'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should reject amount that does not match the group required contribution', async () => {
            // Group requires 10 XLM; user tries to contribute a different amount
            await processor.processCommand('12345', 'CONTRIBUTE 50');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.amount_mismatch'));
            expect(mockAddContribution).not.toHaveBeenCalled();
        });

        it('should accept a valid amount that exactly matches group requirement', async () => {
            // Group requires 10 XLM
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockAddContribution).toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.success'));
        });

        it('should accept a valid decimal amount matching the group requirement', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([
                { role: 'MEMBER', groupId: 'g2', group: { id: 'g2', name: 'G2', contributionAmount: 10.5, contributionFrequency: 'WEEKLY', members: [] } },
            ]);
            await processor.processCommand('12345', 'CONTRIBUTE 10.5');
            expect(mockAddContribution).toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.success'));
        });
    });

    describe('handleCreateGroup amount validation', () => {
        it('should reject zero contribution amount', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Savings 0 MONTHLY');
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.zero_amount'));
        });

        it('should reject non-numeric contribution amount', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Savings abc MONTHLY');
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
        });

        it('should reject contribution amount with more than 7 decimal places', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Savings 5.12345678 MONTHLY');
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.precision_exceeded'));
        });
    });

    describe('handleWithdraw amount validation', () => {
        it('should reject zero withdrawal amount', async () => {
            await processor.processCommand('12345', 'WITHDRAW 0');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.zero_amount'));
        });

        it('should reject non-numeric withdrawal amount', async () => {
            await processor.processCommand('12345', 'WITHDRAW abc');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
        });

        it('should reject withdrawal amount with more than 7 decimal places', async () => {
            await processor.processCommand('12345', 'WITHDRAW 1.12345678');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.precision_exceeded'));
        });
    });

    describe('handleRequest', () => {
        it('should send request to recipient and confirmation to sender', async () => {
            await processor.processCommand('12345', 'REQUEST 25 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('67890', expect.stringContaining('request.notify_recipient'));
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('request.confirmation'));
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'REQUEST 25');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('request.usage'));
        });

        it('should handle missing recipient', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'REQUEST 25 @ghost');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('request.no_user'));
        });
    });

    describe('handleCreateGroup', () => {
        it('should create group with parsed args', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Savings 50 MONTHLY');
            expect(mockCreateGroup).toHaveBeenCalledWith('u1', 'Savings', '50', 'MONTHLY');
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'CREATE GROUP');
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('create_group.usage'));
        });

        it('should handle group creation failure', async () => {
            mockCreateGroup.mockRejectedValueOnce(new Error('Name taken'));
            await processor.processCommand('12345', 'CREATE GROUP Savings 50 MONTHLY');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('create_group.failed'));
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
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('join_group.usage'));
        });
    });

    describe('handleInviteMember', () => {
        it('should show usage when missing target', async () => {
            await processor.processCommand('12345', 'INVITE MEMBER');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('invite_member.usage'));
        });

        it('should handle missing recipient', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'INVITE MEMBER @ghost');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('invite_member.no_user'));
        });

        it('should handle user not being a group creator', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'INVITE MEMBER @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('invite_member.not_creator'));
        });
    });

    describe('handleGroupStatus', () => {
        it('should handle no groups', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'GROUP STATUS');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('group_status.no_groups'));
        });
    });

    describe('handleWithdraw', () => {
        it('should show usage when missing amount', async () => {
            await processor.processCommand('12345', 'WITHDRAW');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdraw.usage'));
        });

        it('should handle no group membership', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'WITHDRAW 100');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdraw.no_group'));
        });

        it('should confirm withdrawal', async () => {
            await processor.processCommand('12345', 'WITHDRAW 100');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdraw.success'));
        });
    });

    describe('error handling', () => {
        it('should catch and report errors from handlers', async () => {
            mockGetOrCreateUser.mockRejectedValueOnce(new Error('DB connection failed'));
            await processor.processCommand('12345', 'BALANCE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('error.generic'));
        });
    });

    describe('handleBalance edge cases', () => {
        it('should handle missing wallet', async () => {
            mockGetOrCreateUser.mockResolvedValueOnce({
                id: 'u1', phoneNumber: '12345', stellarWallet: null, language: 'en',
            });
            await processor.processCommand('12345', 'BALANCE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('balance.no_wallet'));
        });
    });
});
