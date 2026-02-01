import express from 'express';
import morgan from 'morgan';
import Logger from './logger.js';
import fs from 'fs';
import { optionalBool, optional } from './env.js';

const IS_DEV = process.env.NODE_ENV === 'development';

if (IS_DEV) {
    const dotenv = await import('dotenv');
    dotenv.config();
}

const PORT = optional('PORT', 3001);
const DEBUG = optionalBool('DEBUG', false);

const log = new Logger('tools-main', DEBUG);

log.info(`Starting main application in ${IS_DEV ? 'development' : 'production'} mode`);

const app = express();
app.use(express.json());
app.use(morgan(IS_DEV ? 'dev' : 'tiny', {
    stream: {
        write: msg => log.info(msg.trim())
    }
}));

app.get('/health', (_, res) => res.json({ ok: true }));

const startModule = async (name, loader) => {
    log.info(`Starting module: ${name}`);

    const module = await loader();
    const serviceLog = log.child(name);

    serviceLog.info(`Starting ${name} v${module.version}`);

    module.start({ app, log: serviceLog });
};

const moduleFiles = fs.readdirSync('./modules').filter(f => f.endsWith('.js'));

for (const file of moduleFiles) {
    await startModule(file, () => import(`./modules/${file}`));
}

app.listen(PORT, () => log.info(`Server listening on port ${PORT}`));