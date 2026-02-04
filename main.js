import express from 'express';
import morgan from 'morgan';
import axios from 'axios';
import path from 'path';
import Logger from './logger.js';
import fs from 'fs';
import { optionalBool, optional, required } from './env.js';
import pkg from './package.json' with { type: 'json' };
import { fileURLToPath } from 'url';

const IS_DEV = process.env.NODE_ENV === 'development';

if (IS_DEV) {
    const dotenv = await import('dotenv');
    dotenv.config();
}

const PORT = optional('PORT', 3001);
const DEBUG = optionalBool('DEBUG', false);
const EMBY_URL = required('EMBY_URL');
const EMBY_API_KEY = required('EMBY_API_KEY');
const DISABLED_MODULES = optional('DISABLED_MODULES', '').split(',').map(m => m.trim());

const log = new Logger('tools-main', DEBUG);
const app = express();
const emby = axios.create({
    baseURL: `${EMBY_URL}/emby`,
    headers: {
        "X-Emby-Token": EMBY_API_KEY
    }
});

app.use(express.json());
app.use(morgan(IS_DEV ? 'dev' : 'tiny', {
    stream: {
        write: msg => log.info(msg.trim())
    }
}));

app.get('/health', (_, res) => res.json({ ok: true }));

const startModule = async (name, loader) => {
    log.info(`Starting: ${name}`);

    const module = await loader();
    const serviceLog = log.child(name);

    module.start({ app, emby, log: serviceLog });

    serviceLog.info(`Started ${name}_v${module.version}`);
};

log.info(`${pkg.name}_v${pkg.version} starting...`);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const modulesDir = path.join(dirname, 'modules');
const moduleFiles = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));

for (const file of moduleFiles) {
    if (DISABLED_MODULES.includes(file.replace('.js', ''))) {
        log.info(`Skipping disabled module: ${file}`);
        continue;
    }

    const modulePath = path.join(modulesDir, file);
    await startModule(file, () => import(modulePath));
}

app.listen(PORT, () => log.info(`Server listening on port ${PORT}`));