import ms from 'ms';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { required, optionalBool } from '../env.js';

export const version = '1.0.2';

export const start = async (ctx) => {
    const { app, log, emby } = ctx;   

    const EMBY_LIBRARY_VIEW_USER = required('EMBY_LIBRARY_VIEW_USER');
    const DB_PATH = required('DB_PATH');
    const SYNC_INTERVAL = required('SYNC_INTERVAL');
    const FORGET_TIME = required('FORGET_TIME');
    const PERFORM_INITIAL_SYNC = optionalBool('PERFORM_INITIAL_SYNC', false);
    
    const adapter = new JSONFile(DB_PATH);
    const db = new Low(adapter, { movies: {} });
    
    const getMovieEntry = providerId => db.data.movies[providerId];
    
    const setMovieEntry = async (providerId, value) => {
        db.data.movies[providerId] = value;
        await db.write();
    }
    
    const deleteMovieEntry = async providerId => {
        delete db.data.movies[providerId];
        await db.write();
    }
    
    const getProviderFromItem = item => {
        const providers = item?.ProviderIds || {};
    
        if (providers.Tmdb) return `tmdb:${providers.Tmdb}`;
        if (providers.Tvdb) return `tvdb:${providers.Tvdb}`;
        if (providers.Imdb) return `imdb:${providers.Imdb}`;
    
        return null;
    }
    
    const handleMediaAdded = async (providerId, item, currentISO) => {
        await setMovieEntry(providerId, {
            baseline: item.DateCreated,
            lastSeen: currentISO
        });
    
        log.debug(`Added movie entry for ${providerId} (${item.Name})`);
    }
    
    const updateItemDateCreated = async (item, newDateISO) => {
        const payload = { ...item, DateCreated: newDateISO };
        await emby.post(`/Items/${item.Id}`, payload);
    }
    
    const handleExistingMedia = async (providerId, item, entry, nowISO) => {
        const baselineISO = entry.baseline || nowISO;
        const embyItemISO = item.DateCreated;
    
        const baselineMs = Date.parse(baselineISO);
        const embyItemMs = Date.parse(embyItemISO);
    
        let newBaseline = baselineISO;
    
        if (embyItemMs < baselineMs) {
            newBaseline = embyItemISO;
            log.info(`Updating baseline for ${providerId} (${item.Name}) from ${baselineISO} to ${newBaseline}`);
        }
    
        if (embyItemMs > baselineMs) {
            try {
                log.info(`Updating Emby date for ${providerId} (${item.Name}) from ${item.DateCreated} to ${newBaseline}`);
                await updateItemDateCreated(item, newBaseline);
                return true;
            } catch (err) {
                log.error(`Failed to update date for ${providerId} (${item.Name})`, err);
            }
        }
    
        await setMovieEntry(providerId, {
            baseline: newBaseline,
            lastSeen: nowISO
        });
    
        return false;
    }
    
    const getMoviesPage = async (userId, startIndex, limit) => {
        const { data } = await emby(`/Users/${userId}/Items`, {
            params: {
                IncludeItemTypes: 'Movie,Episode',
                Recursive: true,
                Fields: 'DateCreated,ProviderIds',
                StartIndex: startIndex,
                Limit: limit
            }
        });
    
        return data;
    }
    
    const sync = async () => {
        try {
            log.info('Beginning sync with Emby server...');
    
            const now = new Date();
            const nowISO = now.toISOString();
            const nowMs = now.getTime();
    
            const seen = new Set();
    
            let created = 0;
            let updated = 0;
            let missing = 0;
            let deleted = 0;
    
            const pageSize = 250;
            let startIndex = 0;
    
            while (true) {
                const page = await getMoviesPage(EMBY_LIBRARY_VIEW_USER, startIndex, pageSize);
                const items = page.Items;
    
                if (!items.length) break;
    
                for (const item of items) {
                    try {
                        const providerId = getProviderFromItem(item);
    
                        if (!providerId) {
                            log.debug(`Skipping item due to missing providerId -- (${item.Name})`);
                            continue;
                        };
    
                        log.debug(`Processing ${providerId} (${item.Name})`)
    
                        seen.add(providerId);
    
                        const entry = getMovieEntry(providerId);
    
                        if (!entry) {
                            log.debug(`New media found ${providerId} (${item.Name})`);
    
                            await handleMediaAdded(providerId, item, nowISO);
    
                            created++;
    
                            continue;
                        }
    
                        const wasUpdated = await handleExistingMedia(providerId, item, entry, nowISO);
    
                        if (wasUpdated) updated++;
                    } catch (err) {
                        log.error(`Error processing ${item.Name} (${item.Id})`, err);
                    }
                }
    
                startIndex += items.length;
                if (items.length < pageSize) break;
            }
    
            for (const [providerId, entry] of Object.entries(db.data.movies)) {
                if (seen.has(providerId)) continue;
    
                missing++;
    
                const lastSeenMs = Date.parse(entry.lastSeen);
    
                if (nowMs - lastSeenMs > ms(FORGET_TIME)) {
                    log.info(`Deleting ${providerId} from database due to being missing for longer than specified FORGET_TIME.`);
                    await deleteMovieEntry(providerId);
                    missing--;
                    deleted++;
                }
            }
    
            log.info(`Finished syncing... Added ${created} database entries, Updated ${updated} entries, ${missing} missing entries, Deleted ${deleted} entries.`);
        } catch (err) {
            log.error('Failed to sync..', err);
        }
    }
    
    app.post('/import-saver', async (req, res) => {
        const body = req.body;
        const event = body.Event;
        const item = body.Item;

        if (event === 'system.notificationtest') return res.sendStatus(200);
    
        if (event !== 'library.new') {
            log.info(`Unhandled event received: ${event}`);
            return res.sendStatus(400);
        }
    
        log.info('Received media added event...');
    
        if (!['Movie', 'Episode'].includes(item.Type)) {
            log.info(`Ignoring item of type: ${item.Type}`);
            return res.sendStatus(200);
        }
    
        const providerId = getProviderFromItem(item);
    
        if (!providerId) {
            log.info(`Ignoring item due to missing providerId -- (${item.Name})`);
            return res.sendStatus(200);
        }
    
        const nowIso = new Date().toISOString()
        const entry = getMovieEntry(providerId);
        if (!entry) {
            await handleMediaAdded(providerId, item, nowIso).catch(log.error);
        } else {
            await handleExistingMedia(providerId, item, entry, nowIso).catch(log.error);
        }
    
        res.sendStatus(200);
    });
    
    // Initialize Database
    await db.read();
    
    // Begin Syncing
    if (PERFORM_INITIAL_SYNC) sync();
    setInterval(sync, ms(SYNC_INTERVAL));
}