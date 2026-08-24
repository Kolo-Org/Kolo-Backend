import { PrismaClient } from '@prisma/client';
import { applyEncryptionMiddleware } from '../middleware/prisma-encryption.middleware';

export const prisma = new PrismaClient();

applyEncryptionMiddleware(prisma);
