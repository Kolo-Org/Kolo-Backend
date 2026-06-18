import express from 'express';
import botRoutes from './routes/bot.routes';
import { config } from './config/env';
import { startWorker } from './workers/message.worker';

const app = express();

app.use(express.json());

app.use('/api', botRoutes);

app.get('/', (req, res) => {
    res.send('Kolo Backend is running');
});

app.listen(config.PORT, () => {
    console.log(`Server is listening on port ${config.PORT}`);
    startWorker();
});
