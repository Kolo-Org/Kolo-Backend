import express, { type ErrorRequestHandler } from 'express';
import { StrKey } from '@stellar/stellar-sdk';
import botRoutes from './routes/bot.routes';
import { config } from './config/env';
import { startWorker } from './workers/message.worker';
import { observabilityService } from './services/observability.service';

if (!config.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
}

if (config.USDC_ISSUER_PUBLIC_KEY && !StrKey.isValidEd25519PublicKey(config.USDC_ISSUER_PUBLIC_KEY)) {
    throw new Error('USDC_ISSUER_PUBLIC_KEY is set but is not a valid Stellar public key');
}

// Process-level safety net. These are the last line of defence for the
// "unhandled promise rejection" failure mode: any rejection or throw that
// escapes a request handler, worker, or timer is logged here instead of
// taking the process down without a trace.
process.on('unhandledRejection', (reason) => {
    observabilityService.alertCriticalFailure('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (err) => {
    observabilityService.alertCriticalFailure('Uncaught exception', err).finally(() => {
        // After an uncaught exception the process is in an undefined state; exit so
        // the orchestrator can restart it cleanly rather than serve corrupt state.
        process.exit(1);
    });
});

const app = express();

app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use('/api', botRoutes);

app.get('/', (req, res) => {
    res.send('Kolo Backend is running');
});

// Centralised error-handling middleware. Express 5 forwards rejected promises
// from async route handlers here, so any error that slips past a controller's
// own try/catch still produces a clean 500 instead of a default error page or
// a hung request.
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    observabilityService.alertCriticalFailure('Unhandled request error', err, { path: req.path, method: req.method });
    if (res.headersSent) {
        return next(err);
    }
    res.sendStatus(500);
};
app.use(errorHandler);

const server = app.listen(config.PORT, () => {
    observabilityService.logInfo(`Server is listening on port ${config.PORT}`);
    startWorker();
});

// Enforce a server-level timeout
server.setTimeout(30000);
