import dotenv from 'dotenv';
dotenv.config();

export const config = {
    PORT: process.env.PORT || 3000,
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET || '',
    VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'kolo_verify_token',
    DATABASE_URL: process.env.DATABASE_URL || '',
    STELLAR_NETWORK: process.env.STELLAR_NETWORK || 'TESTNET', // TESTNET or PUBLIC
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '', // Must be a 32-byte hex string
    USDC_ISSUER_PUBLIC_KEY: process.env.USDC_ISSUER_PUBLIC_KEY || '', // SDF testnet issuer or Circle/centre.io mainnet issuer, depending on STELLAR_NETWORK
    SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    CONTRACT_WASM_PATH: process.env.CONTRACT_WASM_PATH || 'contracts/savings_group.wasm',
    DEPLOYER_SECRET_KEY: process.env.DEPLOYER_SECRET_KEY || '',
    USDC_TOKEN_ADDRESS: process.env.USDC_TOKEN_ADDRESS || 'CCW67TSBXSHOMEVDBLAEXGPSDMT2OVL4TJBB25KVEA2MOWFK76OO5SS7',
};

