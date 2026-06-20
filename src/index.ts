import express, { type ErrorRequestHandler } from 'express';
import botRoutes from './routes/bot.routes';
import { config } from './config/env';
import { startWorker } from './workers/message.worker';

if (!config.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
}

// Process-level safety net. These are the last line of defence for the
// "unhandled promise rejection" failure mode: any rejection or throw that
// escapes a request handler, worker, or timer is logged here instead of
// taking the process down without a trace.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    // After an uncaught exception the process is in an undefined state; exit so
    // the orchestrator can restart it cleanly rather than serve corrupt state.
    process.exit(1);
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
const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
    console.error('Unhandled request error:', err);
    if (res.headersSent) {
        return next(err);
    }
    res.sendStatus(500);
};
app.use(errorHandler);

app.listen(config.PORT, () => {
    console.log(`Server is listening on port ${config.PORT}`);
    startWorker();
});
