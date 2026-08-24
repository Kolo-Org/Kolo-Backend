import { PrismaClient } from '@prisma/client';
import { encryptField, decryptField, isEncryptedFieldBlob, hmacPhone } from '../utils/encryption.util';

type PrismaAction =
    | 'create'
    | 'createMany'
    | 'update'
    | 'updateMany'
    | 'upsert'
    | 'findUnique'
    | 'findUniqueOrThrow'
    | 'findFirst'
    | 'findFirstOrThrow'
    | 'findMany'
    | 'count'
    | 'aggregate'
    | 'groupBy';

const WRITE_ACTIONS: PrismaAction[] = ['create', 'update', 'upsert'];
const READ_RESULT_ACTIONS: PrismaAction[] = [
    'findUnique',
    'findUniqueOrThrow',
    'findFirst',
    'findFirstOrThrow',
    'findMany',
];

function looksLikePlaintextPhone(value: unknown): value is string {
    // Encrypted values are JSON blobs starting with '{'; anything else that
    // reaches a phone-number field is treated as plaintext input.
    return typeof value === 'string' && !isEncryptedFieldBlob(value);
}

// Rewrites every `phoneNumber` equality filter into its HMAC equivalent so
// callers can keep querying with plaintext. Handles both top-level
// `where.phoneNumber` and nested `where.user.phoneNumber` filters.
function rewriteWhereClause(where: Record<string, any> | undefined): Record<string, any> | undefined {
    if (!where || typeof where !== 'object') {
        return where;
    }

    const rewritten = { ...where };

    if (looksLikePlaintextPhone(rewritten.phoneNumber)) {
        rewritten.phoneNumberHash = hmacPhone(rewritten.phoneNumber);
        delete rewritten.phoneNumber;
    }

    return rewritten;
}

// Rewrites only the nested `user.phoneNumber` filter, for relation queries on
// models like GroupMember. Top-level phone filters are handled by
// rewriteWhereClause for the User model itself.
function rewriteNestedUserFilter(where: Record<string, any> | undefined): Record<string, any> | undefined {
    if (!where || typeof where !== 'object' || !looksLikePlaintextPhone(where.user?.phoneNumber)) {
        return where;
    }

    const nested = { ...where.user };
    delete nested.phoneNumber;

    return {
        ...where,
        user: { ...nested, phoneNumberHash: hmacPhone(where.user.phoneNumber) },
    };
}

// Encrypts a plaintext `data.phoneNumber` value and derives the lookup hash.
function encryptDataPayload(data: Record<string, any>): Record<string, any> {
    const payload = { ...data };

    if (looksLikePlaintextPhone(payload.phoneNumber)) {
        const phoneNumber = payload.phoneNumber;
        payload.phoneNumber = encryptField(phoneNumber);
        payload.phoneNumberHash = hmacPhone(phoneNumber);
    }

    return payload;
}

// Decrypts phone numbers on query results before they reach the caller.
function decryptResult(result: any): any {
    if (result === null || result === undefined) {
        return result;
    }

    if (Array.isArray(result)) {
        return result.map(decryptResult);
    }

    if (typeof result === 'object') {
        const copy = { ...result } as Record<string, any>;

        if (typeof copy.phoneNumber === 'string' && isEncryptedFieldBlob(copy.phoneNumber)) {
            try {
                copy.phoneNumber = decryptField(copy.phoneNumber);
            } catch (err) {
                console.error('Failed to decrypt user phone number:', err);
            }
        }

        if (copy.user) {
            copy.user = decryptResult(copy.user);
        }

        return copy;
    }

    return result;
}

export function applyEncryptionMiddleware(prismaClient: PrismaClient): void {
    prismaClient.$use(async (params, next) => {
        const isUserModel = params.model === 'User';
        const action = params.action as PrismaAction;

        if (isUserModel && WRITE_ACTIONS.includes(action) && params.args) {
            if (action === 'upsert') {
                // Upsert splits its payload across create/update instead of data.
                if (params.args.create) {
                    params.args.create = encryptDataPayload(params.args.create);
                }
                if (params.args.update) {
                    params.args.update = encryptDataPayload(params.args.update);
                }
                params.args.where = rewriteWhereClause(params.args.where);
            } else if (params.args.data) {
                params.args = { ...params.args, data: encryptDataPayload(params.args.data) };
            }
        }

        if (params.args?.where && action !== 'create') {
            const where = params.args.where;
            const rewritten = isUserModel ? rewriteWhereClause(where) : rewriteNestedUserFilter(where);
            params.args = { ...params.args, where: rewritten };
        }

        const result = await next(params);

        // Relation reads (e.g. GroupMember with include: { user: true }) also
        // carry encrypted phone numbers, so decryption is not limited to the
        // User model.
        if (READ_RESULT_ACTIONS.includes(action)) {
            return decryptResult(result);
        }

        return result;
    });
}
