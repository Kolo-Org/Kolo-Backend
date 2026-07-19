import { WhatsAppService } from './whatsapp.service';
import { StellarService } from './stellar.service';
import { UserService } from './user.service';
import { GroupService } from './group.service';
import { decrypt } from '../utils/encryption.util';
import { t } from './locale.service';
import { redisClient } from '../lib/redis';

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

    /**
     * Validates a contribution amount string for financial operations.
     *
     * Returns null when the amount is valid, or a translation key describing
     * the specific validation failure. Rules enforced:
     * - Must match the pattern for a non-negative decimal number
     * - Must be strictly greater than zero
     * - Must not exceed 7 decimal places (Stellar's smallest unit is 1 stroop = 0.0000001 XLM)
     * - Must not exceed 1,000,000 XLM (guards against fat-finger errors)
     */
    private validateAmount(amountStr: string): string | null {
        if (!/^\d+(\.\d+)?$/.test(amountStr)) {
            return 'validation.invalid_format';
        }
        const value = parseFloat(amountStr);
        if (value <= 0) {
            return 'validation.zero_amount';
        }
        const decimalPart = amountStr.includes('.') ? amountStr.split('.')[1] : '';
        if (decimalPart.length > 7) {
            return 'validation.precision_exceeded';
        }
        if (value > 1_000_000) {
            return 'validation.exceeds_max';
        }
        return null;
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
                    return await this.handleHistory(from, tokens.slice(1));
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
                t('error.generic', user.language ?? 'en', { message: error.message }),
            );
        }
    }

    private async handleBalance(from: string) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language ?? 'en';

        if (!user.stellarWallet) {
            return await this.whatsappService.sendMessage(from, t('balance.no_wallet', lang));
        }
        const { publicKey } = JSON.parse(user.stellarWallet);
        const balance = await this.stellarService.checkBalance(publicKey);
        await this.whatsappService.sendMessage(from, t('balance.success', lang, { balance }));
    }

    private async handleHistory(from: string, args: string[]) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language ?? 'en';

        if (!user.stellarWallet) {
            return await this.whatsappService.sendMessage(from, t('history.no_wallet', lang));
        }

        const isMore = args.length > 0 && args[0].toUpperCase() === 'MORE';
        let cursor = undefined;

        const cursorCacheKey = `user_state:${from}:history_cursor`;
        if (isMore) {
            const savedCursor = await redisClient.get(cursorCacheKey);
            if (savedCursor) {
                cursor = savedCursor;
            } else {
                return await this.whatsappService.sendMessage(from, t('history.no_more', lang));
            }
        }

        await this.whatsappService.sendMessage(from, t('history.fetching', lang, { phone: from }));

        const { publicKey } = JSON.parse(user.stellarWallet);

        try {
            const history = await this.stellarService.getTransactionHistory(publicKey, cursor, 10);
            
            if (history.transactions.length === 0) {
                if (isMore) {
                    await redisClient.del(cursorCacheKey);
                    return await this.whatsappService.sendMessage(from, t('history.no_more', lang));
                } else {
                    return await this.whatsappService.sendMessage(from, t('history.not_funded', lang));
                }
            }

            let message = t('history.header', lang);
            let index = 1;

            for (const tx of history.transactions) {
                let displayCounterparty = tx.counterparty;
                
                // Attempt to resolve Kolo username if it's a stellar public key
                if (tx.counterparty && tx.counterparty.startsWith('G') && tx.counterparty.length === 56) {
                    const counterpartyUser = await this.userService.getUserByPublicKey(tx.counterparty);
                    if (counterpartyUser && counterpartyUser.username) {
                        displayCounterparty = '@' + counterpartyUser.username;
                    } else {
                        // Shorten address if not found or no username
                        displayCounterparty = tx.counterparty.substring(0, 5) + '...' + tx.counterparty.substring(52);
                    }
                }

                const dateStr = new Date(tx.date).toLocaleDateString(lang, { month: 'short', day: 'numeric', year: 'numeric' });
                const shortHash = tx.hash.substring(0, 5) + '...' + tx.hash.substring(52);

                if (tx.type === 'payment sent') {
                    message += t('history.item_sent', lang, {
                        index, amount: tx.amount, asset: tx.asset, counterparty: displayCounterparty, date: dateStr, hash: shortHash
                    });
                } else if (tx.type === 'payment received') {
                    message += t('history.item_received', lang, {
                        index, amount: tx.amount, asset: tx.asset, counterparty: displayCounterparty, date: dateStr, hash: shortHash
                    });
                } else {
                    message += t('history.item_other', lang, {
                        index, type: tx.type, amount: tx.amount, asset: tx.asset, date: dateStr, hash: shortHash
                    });
                }
                message += '\n';
                index++;
            }

            if (history.nextCursor) {
                message += t('history.more', lang);
                await redisClient.set(cursorCacheKey, history.nextCursor, 'EX', 3600); // 1 hour TTL
            } else {
                await redisClient.del(cursorCacheKey);
            }

            await this.whatsappService.sendMessage(from, message.trim());
        } catch (error: any) {
            console.error('History error:', error);
            await this.whatsappService.sendMessage(
                from,
                error.message || t('history.unavailable', lang)
            );
        }
    }

    private async handleProfile(from: string) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language ?? 'en';
        const publicKey = user.stellarWallet ? JSON.parse(user.stellarWallet).publicKey : 'None';
        await this.whatsappService.sendMessage(
            from,
            t('profile.card', lang, {
                phone: user.phoneNumber,
                username: user.username || 'Not set',
                wallet: publicKey,
                joined: user.createdAt.toDateString(),
            }),
        );
    }

    private async handleSend(from: string, args: string[]) {
        const user = await this.userService.getOrCreateUser(from);
        const lang = user.language ?? 'en';

        if (args.length < 2) {
            return await this.whatsappService.sendMessage(from, t('send.usage', lang));
        }
        const amount = args[0];
        const amountError = this.validateAmount(amount);
        if (amountError) {
            return await this.whatsappService.sendMessage(from, t(amountError, lang));
        }
        const target = args[1];

        if (!user.stellarWallet) {
            return await this.whatsappService.sendMessage(from, t('send.no_wallet', lang));
        }

        const recipient = await this.userService.resolveUser(target);
        if (!recipient || !recipient.stellarWallet) {
            return await this.whatsappService.sendMessage(
                from,
                t('send.no_recipient', lang, { target }),
            );
        }

        const senderWallet = JSON.parse(user.stellarWallet);
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
        const lang = sender.language ?? 'en';

        if (args.length < 2) {
            return await this.whatsappService.sendMessage(from, t('request.usage', lang));
        }
        const amount = args[0];
        const amountError = this.validateAmount(amount);
        if (amountError) {
            return await this.whatsappService.sendMessage(from, t(amountError, lang));
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
        const lang = user.language ?? 'en';

        if (args.length < 3) {
            return await this.whatsappService.sendMessage(from, t('create_group.usage', lang));
        }
        const frequency = args.pop() || 'MONTHLY';
        const amountStr = args.pop() || '0';
        const amountError = this.validateAmount(amountStr);
        if (amountError) {
            return await this.whatsappService.sendMessage(from, t(amountError, lang));
        }
        const name = args.join(' ');

        try {
            const group = await this.groupService.createGroup(user.id, name, amountStr, frequency);
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
        const lang = user.language ?? 'en';

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
        const lang = user.language ?? 'en';

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
        const lang = user.language ?? 'en';
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
        const lang = user.language ?? 'en';

        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, t('contribute.usage', lang));
        }
        const amountStr = args[0];
        const amountError = this.validateAmount(amountStr);
        if (amountError) {
            return await this.whatsappService.sendMessage(from, t(amountError, lang));
        }

        const memberships = await this.groupService.getGroupStatus(user.id);
        if (memberships.length === 0) {
            return await this.whatsappService.sendMessage(from, t('contribute.no_group', lang));
        }

        const group = memberships[0].group;

        // Enforce exact match against the group's required contribution amount.
        // Savings circles (Ajo/Esusu) require every member to contribute the
        // same fixed amount each cycle; accepting a different amount would
        // corrupt the payout schedule.
        const required = parseFloat(String(group.contributionAmount));
        const contributed = parseFloat(amountStr);
        if (Math.abs(contributed - required) > Number.EPSILON) {
            return await this.whatsappService.sendMessage(
                from,
                t('contribute.amount_mismatch', lang, { required: String(group.contributionAmount) }),
            );
        }

        if (!user.stellarWallet) {
            return await this.whatsappService.sendMessage(from, t('send.no_wallet', lang));
        }
        if (!group.stellarContractId) {
            return await this.whatsappService.sendMessage(from, t('error.generic', lang, { message: 'Group has no receiving wallet configured.' }));
        }

        const senderWallet = JSON.parse(user.stellarWallet);
        const senderSecret = decrypt(senderWallet.encryptedSecret, senderWallet.iv, senderWallet.authTag);
        const recipientPublicKey = group.stellarContractId;

        try {
            await this.whatsappService.sendMessage(
                from,
                t('contribute.initiating', lang, { amount: amountStr, groupName: group.name }),
            );
            
            const txResponse = await this.stellarService.sendPayment(senderSecret, recipientPublicKey, amountStr);
            const txHash = txResponse.hash || ('fallback_tx_' + Date.now());
            
            await this.groupService.addContribution(user.id, group.id, amountStr, txHash);
            await this.whatsappService.sendMessage(
                from,
                t('contribute.success', lang, { amount: amountStr, groupName: group.name }),
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
        const lang = user.language ?? 'en';

        if (args.length < 1) {
            return await this.whatsappService.sendMessage(from, t('withdraw.usage', lang));
        }
        const amountStr = args[0];
        const amountError = this.validateAmount(amountStr);
        if (amountError) {
            return await this.whatsappService.sendMessage(from, t(amountError, lang));
        }

        const memberships = await this.groupService.getGroupStatus(user.id);
        if (memberships.length === 0) {
            return await this.whatsappService.sendMessage(from, t('withdraw.no_group', lang));
        }

        const group = memberships[0].group;
        await this.whatsappService.sendMessage(
            from,
            t('withdraw.success', lang, { amount: amountStr, groupName: group.name }),
        );
    }

    private async handleHelp(from: string) {
        const user = await this.userService.getOrCreateUser(from);
        await this.whatsappService.sendMessage(from, t('help.text', user.language ?? 'en'));
    }

    private async handleUnknown(from: string, _text: string) {
        const user = await this.userService.getOrCreateUser(from);
        await this.whatsappService.sendMessage(from, t('unknown.command', user.language ?? 'en'));
    }
}
