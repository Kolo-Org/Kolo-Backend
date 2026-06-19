import { WhatsAppService } from './whatsapp.service';
import { StellarService } from './stellar.service';
import { UserService } from './user.service';
import { GroupService } from './group.service';
import { decrypt } from '../utils/encryption.util';
import { t } from './locale.service';

export class MessageProcessor {
    private whatsappService: WhatsAppService;
    private stellarService: StellarService;
    private userService: UserService;
    private groupService: GroupService;

    constructor(
        whatsappService?: WhatsAppService,
        stellarService?: StellarService,
        userService?: UserService,
        groupService?: GroupService,
    ) {
        this.whatsappService = whatsappService ?? new WhatsAppService();
        this.stellarService = stellarService ?? new StellarService();
        this.userService = userService ?? new UserService();
        this.groupService = groupService ?? new GroupService();
    }

    private isValidAmount(amountStr: string): boolean {
        return /^\d+(\.\d+)?$/.test(amountStr);
    }

    public async processCommand(from: string, text: string) {
        const tokens = text.trim().split(/\s+/);
        if (tokens.length === 0) return;

        const cmd1 = tokens[0].toUpperCase();
        const cmd2 = tokens.length > 1 ? tokens[1].toUpperCase() : '';

        try {
            if (cmd1 === 'CREATE' && cmd2 === 'GROUP') {
                return await this.handleCreateGroup(from, tokens.slice(2));
            } else if (cmd1 === 'JOIN' && cmd2 === 'GROUP') {
                return await this.handleJoinGroup(from, tokens.slice(2));
            } else if (cmd1 === 'INVITE' && cmd2 === 'MEMBER') {
                return await this.handleInviteMember(from, tokens.slice(2));
            } else if (cmd1 === 'GROUP' && cmd2 === 'STATUS') {
                return await this.handleGroupStatus(from, tokens.slice(2));
            }

            switch (cmd1) {
                case 'BALANCE':
                    return await this.handleBalance(from);
                case 'HISTORY':
                    return await this.handleHistory(from);
                case 'PROFILE':
                    return await this.handleProfile(from);
                case 'SEND':
                    return await this.handleSend(from, tokens.slice(1));
                case 'REQUEST':
                    return await this.handleRequest(from, tokens.slice(1));
                case 'CONTRIBUTE':
                    return await this.handleContribute(from, tokens.slice(1));
                case 'WITHDRAW':
                    return await this.handleWithdraw(from, tokens.slice(1));
                case 'HELP':
                case 'SUPPORT':
                    return await this.handleHelp(from);
                default:
                    return await this.handleUnknown(from, text);
            }
        } catch (error: any) {
            console.error('Error processing command:', error);
            const user = await this.userService.getOrCreateUser(from).catch(() => ({ language: 'en' }));
            await this.whatsappService.sendMessage(
                from,
                t('error.generic', user.language, { message: error.message }),
            );
        }
    }

    private async handleBalance(from: string) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language;

        if (!user.stellarWallet) {
            return await this.whatsappService.sendMessage(from, t('balance.no_wallet', lang));
        }
        const { publicKey } = JSON.parse(user.stellarWallet);
        const balance = await this.stellarService.checkBalance(publicKey);
        await this.whatsappService.sendMessage(from, t('balance.success', lang, { balance }));
    }

    private async handleHistory(from: string) {
        const user = await this.userService.getOrCreateUser(from);
        await this.whatsappService.sendMessage(
            from,
            t('history.fetching', user.language, { phone: from }),
        );
    }

    private async handleProfile(from: string) {
        const user = await this.userService.getOrCreateUser(from);
        const publicKey = user.stellarWallet ? JSON.parse(user.stellarWallet).publicKey : 'None';
        const profileInfo = `*Kolo Profile*\n` +
            `Phone: ${user.phoneNumber}\n` +
            `Username: ${user.username || 'Not set'}\n` +
            `Wallet: ${publicKey}\n` +
            `Joined: ${user.createdAt.toDateString()}`;
        await this.whatsappService.sendMessage(from, profileInfo);
    }

    private async handleSend(from: string, args: string[]) {
        const sender = await this.userService.getOrCreateUser(from);
        const lang = sender.language;

        if (args.length < 2) {
            return await this.whatsappService.sendMessage(from, t('send.usage', lang));
        }
        const amount = args[0];
        if (!this.isValidAmount(amount)) {
            return await this.whatsappService.sendMessage(from, 'Error: Invalid amount format.');
        }
        const target = args[1];

        if (!sender.stellarWallet) {
            return await this.whatsappService.sendMessage(from, t('send.no_wallet', lang));
        }

        const recipient = await this.userService.resolveUser(target);
        if (!recipient || !recipient.stellarWallet) {
            return await this.whatsappService.sendMessage(
                from,
                t('send.no_recipient', lang, { target }),
            );
        }

        const senderWallet = JSON.parse(sender.stellarWallet);
        const senderSecret = decrypt(senderWallet.encryptedSecret, senderWallet.iv, senderWallet.authTag);
        const recipientPublicKey = JSON.parse(recipient.stellarWallet).publicKey;

        try {
            await this.whatsappService.sendMessage(
                from,
                t('send.initiating', lang, { amount, target }),
            );
            await this.stellarService.sendPayment(senderSecret, recipientPublicKey, amount);
            await this.whatsappService.sendMessage(
                from,
                t('send.success', lang, { amount, target }),
            );
        } catch (e: any) {
            console.error(e);
            await this.whatsappService.sendMessage(
                from,
                t('send.failed', lang, { message: e.message || 'Transaction error' }),
            );
        }
    }

    private async handleRequest(from: string, args: string[]) {
        const sender = await this.userService.getOrCreateUser(from);
        const lang = sender.language;

        if (args.length < 2) {
            return await this.whatsappService.sendMessage(from, t('request.usage', lang));
        }
        const amount = args[0];
        if (!this.isValidAmount(amount)) {
            return await this.whatsappService.sendMessage(from, 'Error: Invalid amount format.');
        }
        const target = args[1];

        const recipient = await this.userService.resolveUser(target);
        if (!recipient) {
            return await this.whatsappService.sendMessage(
                from,
                t('request.no_user', lang, { target }),
            );
        }

        const senderHandle = sender.username ? '@' + sender.username : sender.phoneNumber;
        await this.whatsappService.sendMessage(
            recipient.phoneNumber,
            t('request.notify_recipient', lang, {
                sender: senderHandle,
                amount,
                senderPhone: sender.phoneNumber,
            }),
        );
        await this.whatsappService.sendMessage(
            from,
            t('request.confirmation', lang, { amount, target }),
        );
    }

    private async handleCreateGroup(from: string, args: string[]) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language;

        if (args.length < 3) {
            return await this.whatsappService.sendMessage(from, t('create_group.usage', lang));
        }
        const frequency = args.pop() || 'MONTHLY';
        const amountStr = args.pop() || '0';
        if (!this.isValidAmount(amountStr)) {
            return await this.whatsappService.sendMessage(from, 'Error: Invalid amount format.');
        }
        const name = args.join(' ');
        const amount = amountStr;

        try {
            const group = await this.groupService.createGroup(user.id, name, amount, frequency);
            await this.whatsappService.sendMessage(
                from,
                t('create_group.success', lang, { name, id: group.id }),
            );
        } catch (e: any) {
            await this.whatsappService.sendMessage(
                from,
                t('create_group.failed', lang, { message: e.message }),
            );
        }
    }

    private async handleJoinGroup(from: string, args: string[]) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language;

        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, t('join_group.usage', lang));
        }
        const groupId = args[0];

        try {
            await this.groupService.joinGroup(user.id, groupId);
            await this.whatsappService.sendMessage(from, t('join_group.success', lang));
        } catch (e: any) {
            await this.whatsappService.sendMessage(
                from,
                t('join_group.failed', lang, { message: e.message }),
            );
        }
    }

    private async handleInviteMember(from: string, args: string[]) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language;

        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, t('invite_member.usage', lang));
        }
        const target = args[0];
        const recipient = await this.userService.resolveUser(target);

        if (!recipient) {
            return await this.whatsappService.sendMessage(
                from,
                t('invite_member.no_user', lang, { target }),
            );
        }

        const memberships = await this.groupService.getGroupStatus(user.id);
        const adminGroup = memberships.find((m: any) => m.role === 'CREATOR');

        if (!adminGroup) {
            return await this.whatsappService.sendMessage(
                from,
                t('invite_member.not_creator', lang),
            );
        }

        const senderHandle = user.username ? '@' + user.username : user.phoneNumber;
        await this.whatsappService.sendMessage(
            recipient.phoneNumber,
            t('invite_member.notify_recipient', lang, {
                sender: senderHandle,
                groupName: adminGroup.group.name,
                groupId: adminGroup.groupId,
            }),
        );
        await this.whatsappService.sendMessage(
            from,
            t('invite_member.success', lang, { target }),
        );
    }

    private async handleGroupStatus(from: string, _args: string[]) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language;
        const memberships = await this.groupService.getGroupStatus(user.id);

        if (memberships.length === 0) {
            return await this.whatsappService.sendMessage(
                from,
                t('group_status.no_groups', lang),
            );
        }

        let statusText = t('group_status.header', lang);
        memberships.forEach((m: any) => {
            statusText += t('group_status.entry', lang, {
                name: m.group.name,
                amount: m.group.contributionAmount,
                frequency: m.group.contributionFrequency,
                role: m.role,
                count: m.group.members.length,
            });
        });

        await this.whatsappService.sendMessage(from, statusText.trim());
    }

    private async handleContribute(from: string, args: string[]) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language;

        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, t('contribute.usage', lang));
        }
        const amountStr = args[0];
        if (!this.isValidAmount(amountStr)) {
            return await this.whatsappService.sendMessage(from, 'Error: Invalid amount format.');
        }
        const amount = amountStr;

        const memberships = await this.groupService.getGroupStatus(user.id);
        if (memberships.length === 0) {
            return await this.whatsappService.sendMessage(from, t('contribute.no_group', lang));
        }

        const group = memberships[0].group;

        try {
            await this.whatsappService.sendMessage(
                from,
                t('contribute.initiating', lang, { amount, groupName: group.name }),
            );
            const txHash = 'mock_tx_' + Date.now();
            await this.groupService.addContribution(user.id, group.id, amount, txHash);
            await this.whatsappService.sendMessage(
                from,
                t('contribute.success', lang, { amount, groupName: group.name }),
            );
        } catch (e: any) {
            await this.whatsappService.sendMessage(
                from,
                t('contribute.failed', lang, { message: e.message }),
            );
        }
    }

    private async handleWithdraw(from: string, args: string[]) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language;

        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, t('withdraw.usage', lang));
        }
        const amountStr = args[0];
        if (!this.isValidAmount(amountStr)) {
            return await this.whatsappService.sendMessage(from, 'Error: Invalid amount format.');
        }
        const amount = amountStr;

        const memberships = await this.groupService.getGroupStatus(user.id);
        if (memberships.length === 0) {
            return await this.whatsappService.sendMessage(from, t('withdraw.no_group', lang));
        }

        const group = memberships[0].group;
        await this.whatsappService.sendMessage(
            from,
            t('withdraw.success', lang, { amount, groupName: group.name }),
        );
    }

    private async handleHelp(from: string) {
        const user = await this.userService.getOrCreateUser(from);
        await this.whatsappService.sendMessage(from, t('help.text', user.language));
    }

    private async handleUnknown(from: string, _text: string) {
        const user = await this.userService.getOrCreateUser(from);
        await this.whatsappService.sendMessage(from, t('unknown.command', user.language));
    }
}
