import express from 'express';
import morgan from 'morgan';
import Logger from './logger.js';
import fs from 'fs';
import { optionalBool, optional } from './env.js';
import pkg from './package.json' with { type: 'json' };

const IS_DEV = process.env.NODE_ENV === 'development';

if (IS_DEV) {
    const dotenv = await import('dotenv');
    dotenv.config();
}

const PORT = optional('PORT', 3001);
const DEBUG = optionalBool('DEBUG', false);


const log = new Logger('tools-main', DEBUG);
const app = express();

app.use(express.json());
app.use(morgan(IS_DEV ? 'dev' : 'tiny', {
    stream: {
        write: msg => log.info(msg.trim())
    }
}));

app.get('/health', (_, res) => res.json({ ok: true }));

const startModule = async (name, loader) => {
    log.info(`Starting module: ${name}_v${module.version}`);
    
    const module = await loader();
    const serviceLog = log.child(name);
    
    module.start({ app, log: serviceLog });
    
    serviceLog.info(`Started ${name}`);
};

log.info(`Starting modules - ${pkg.name}_v${pkg.version}`);

const moduleFiles = fs.readdirSync('./modules').filter(f => f.endsWith('.js'));

for (const file of moduleFiles) {
    await startModule(file, () => import(`./modules/${file}`));
}

app.listen(PORT, () => log.info(`Server listening on port ${PORT}`));