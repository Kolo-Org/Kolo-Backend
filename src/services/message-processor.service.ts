import { WhatsAppService } from './whatsapp.service';
import { StellarService } from './stellar.service';
import { UserService } from './user.service';
import { GroupService } from './group.service';

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
            await this.whatsappService.sendMessage(from, `An error occurred: ${error.message}`);
        }
    }

    private async handleBalance(from: string) {
        const user = await this.userService.getOrCreateUser(from);
        if (!user.stellarWallet) {
            return await this.whatsappService.sendMessage(from, `[BALANCE] Error: Wallet not configured.`);
        }
        const publicKey = user.stellarWallet.split(':')[0];
        const balance = await this.stellarService.checkBalance(publicKey);
        await this.whatsappService.sendMessage(from, `[BALANCE] Your balance is ${balance} XLM.`);
    }

    private async handleHistory(from: string) {
        await this.whatsappService.sendMessage(from, `[HISTORY] Fetching transaction history for ${from}...`);
    }

    private async handleProfile(from: string) {
        const user = await this.userService.getOrCreateUser(from);
        const publicKey = user.stellarWallet ? user.stellarWallet.split(':')[0] : 'None';
        const profileInfo = `*Kolo Profile*\n` +
            `Phone: ${user.phoneNumber}\n` +
            `Username: ${user.username || 'Not set'}\n` +
            `Wallet: ${publicKey}\n` +
            `Joined: ${user.createdAt.toDateString()}`;
        await this.whatsappService.sendMessage(from, profileInfo);
    }

    private async handleSend(from: string, args: string[]) {
        if (args.length < 2) {
            return await this.whatsappService.sendMessage(from, 'Usage: SEND <amount> <@username or phone>');
        }
        const amount = args[0];
        const target = args[1];

        const sender = await this.userService.getOrCreateUser(from);
        if (!sender.stellarWallet) {
            return await this.whatsappService.sendMessage(from, 'Error: Your wallet is not configured.');
        }

        const recipient = await this.userService.resolveUser(target);
        if (!recipient || !recipient.stellarWallet) {
            return await this.whatsappService.sendMessage(from, `Error: Could not find wallet for user ${target}.`);
        }

        const senderSecret = sender.stellarWallet.split(':')[1];
        const recipientPublicKey = recipient.stellarWallet.split(':')[0];

        try {
            await this.whatsappService.sendMessage(from, `[SEND] Initiating transfer of ${amount} XLM to ${target}...`);
            await this.stellarService.sendPayment(senderSecret, recipientPublicKey, amount);
            await this.whatsappService.sendMessage(from, `\u2705 Successfully sent ${amount} XLM to ${target}!`);
        } catch (e: any) {
            console.error(e);
            await this.whatsappService.sendMessage(from, `\u274c [SEND] Failed: ${e.message || 'Transaction error'}`);
        }
    }

    private async handleRequest(from: string, args: string[]) {
        if (args.length < 2) {
            return await this.whatsappService.sendMessage(from, 'Usage: REQUEST <amount> <@username or phone>');
        }
        const amount = args[0];
        const target = args[1];

        const sender = await this.userService.getOrCreateUser(from);
        const recipient = await this.userService.resolveUser(target);

        if (!recipient) {
            return await this.whatsappService.sendMessage(from, `Error: Could not find user ${target}.`);
        }

        const senderHandle = sender.username ? '@' + sender.username : sender.phoneNumber;
        await this.whatsappService.sendMessage(recipient.phoneNumber, `\ud83d\udd14 [REQUEST] ${senderHandle} is requesting ${amount} XLM from you. Reply with: SEND ${amount} ${sender.phoneNumber}`);
        await this.whatsappService.sendMessage(from, `[REQUEST] Request for ${amount} XLM sent to ${target}.`);
    }

    private async handleCreateGroup(from: string, args: string[]) {
        if (args.length < 3) {
            return await this.whatsappService.sendMessage(from, 'Usage: CREATE GROUP <name> <amount> <frequency>');
        }
        const frequency = args.pop() || 'MONTHLY';
        const amountStr = args.pop() || '0';
        const name = args.join(' ');
        const amount = parseFloat(amountStr);

        const user = await this.userService.getOrCreateUser(from);

        try {
            const group = await this.groupService.createGroup(user.id, name, amount, frequency);
            await this.whatsappService.sendMessage(from, `\u2705 Group "${name}" created!\nGroup ID: ${group.id}`);
        } catch (e: any) {
            await this.whatsappService.sendMessage(from, `\u274c Failed to create group: ${e.message}`);
        }
    }

    private async handleJoinGroup(from: string, args: string[]) {
        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, 'Usage: JOIN GROUP <groupId>');
        }
        const groupId = args[0];
        const user = await this.userService.getOrCreateUser(from);

        try {
            await this.groupService.joinGroup(user.id, groupId);
            await this.whatsappService.sendMessage(from, `\u2705 Successfully joined group!`);
        } catch (e: any) {
            await this.whatsappService.sendMessage(from, `\u274c Failed to join group: ${e.message}`);
        }
    }

    private async handleInviteMember(from: string, args: string[]) {
        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, 'Usage: INVITE MEMBER <@username or phone>');
        }
        const target = args[0];
        const user = await this.userService.getOrCreateUser(from);
        const recipient = await this.userService.resolveUser(target);

        if (!recipient) {
            return await this.whatsappService.sendMessage(from, `Error: Could not find user ${target}.`);
        }

        const memberships = await this.groupService.getGroupStatus(user.id);
        const adminGroup = memberships.find((m: any) => m.role === 'CREATOR');

        if (!adminGroup) {
            return await this.whatsappService.sendMessage(from, 'Error: You are not the creator of any group.');
        }

        const senderHandle = user.username ? '@' + user.username : user.phoneNumber;
        await this.whatsappService.sendMessage(recipient.phoneNumber, `\ud83d\udd14 [INVITE] ${senderHandle} invited you to join their savings group "${adminGroup.group.name}".\n\nReply with: JOIN GROUP ${adminGroup.groupId}`);
        await this.whatsappService.sendMessage(from, `\u2705 Invite sent to ${target}.`);
    }

    private async handleGroupStatus(from: string, args: string[]) {
        const user = await this.userService.getOrCreateUser(from);
        const memberships = await this.groupService.getGroupStatus(user.id);

        if (memberships.length === 0) {
            return await this.whatsappService.sendMessage(from, 'You are not part of any groups.');
        }

        let statusText = '*Your Groups:*\n\n';
        memberships.forEach((m: any) => {
            statusText += `*${m.group.name}*\n`;
            statusText += `Target: ${m.group.contributionAmount} XLM (${m.group.contributionFrequency})\n`;
            statusText += `Role: ${m.role}\n`;
            statusText += `Members: ${m.group.members.length}\n\n`;
        });

        await this.whatsappService.sendMessage(from, statusText.trim());
    }

    private async handleContribute(from: string, args: string[]) {
        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, 'Usage: CONTRIBUTE <amount>');
        }
        const amountStr = args[0];
        const amount = parseFloat(amountStr);
        const user = await this.userService.getOrCreateUser(from);

        const memberships = await this.groupService.getGroupStatus(user.id);
        if (memberships.length === 0) {
            return await this.whatsappService.sendMessage(from, 'Error: You are not part of any group.');
        }

        const group = memberships[0].group;

        try {
            await this.whatsappService.sendMessage(from, `[CONTRIBUTE] Initiating contribution of ${amount} XLM to "${group.name}"...`);

            const txHash = 'mock_tx_' + Date.now();
            await this.groupService.addContribution(user.id, group.id, amount, txHash);

            await this.whatsappService.sendMessage(from, `\u2705 Successfully contributed ${amount} XLM to "${group.name}"!`);
        } catch (e: any) {
            await this.whatsappService.sendMessage(from, `\u274c Contribution failed: ${e.message}`);
        }
    }

    private async handleWithdraw(from: string, args: string[]) {
        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, 'Usage: WITHDRAW <amount>');
        }
        const amount = parseFloat(args[0]);
        const user = await this.userService.getOrCreateUser(from);

        const memberships = await this.groupService.getGroupStatus(user.id);
        if (memberships.length === 0) {
            return await this.whatsappService.sendMessage(from, 'Error: You are not part of any group.');
        }

        const group = memberships[0].group;

        await this.whatsappService.sendMessage(from, `\u2705 Successfully withdrew ${amount} XLM from "${group.name}" pool! (MOCKED)`);
    }

    private async handleHelp(from: string) {
        const helpText = `*Kolo Commands:*\n\n` +
            `_Account_\n` +
            `BALANCE\n` +
            `HISTORY\n` +
            `PROFILE\n\n` +
            `_Payments_\n` +
            `SEND <amount> <@user>\n` +
            `REQUEST <amount> <@user>\n\n` +
            `_Savings Groups_\n` +
            `CREATE GROUP <name> <amount> <frequency>\n` +
            `JOIN GROUP <groupId>\n` +
            `INVITE MEMBER <@user>\n` +
            `GROUP STATUS\n` +
            `CONTRIBUTE <amount>\n` +
            `WITHDRAW <amount>\n\n` +
            `_Support_\n` +
            `HELP\n` +
            `SUPPORT`;
        await this.whatsappService.sendMessage(from, helpText);
    }

    private async handleUnknown(from: string, text: string) {
        await this.whatsappService.sendMessage(from, `I didn't understand that command. Send HELP to see available commands.`);
    }
}
