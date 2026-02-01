import axios from 'axios';
import { required } from '../env.js';

export const version = "1.0.2";

export const start = async (ctx) => {
    const { app, log } = ctx;

    const EMBY_URL = required('EMBY_URL');
    const EMBY_KEY = required('EMBY_API_KEY');
    const RADARR_URL = required('RADARR_URL');
    const RADARR_KEY = required('RADARR_KEY');
    const ROOT_FOLDER_PATH = required('ROOT_FOLDER_PATH');
    const QUALITY_PROFILE = required('QUALITY_PROFILE');
    const RADARR_TAG = required('RADARR_TAG');
    
    const radarrApi = axios.create({
        baseURL: `${RADARR_URL}/api/v3`,
        headers: {
            "X-Api-Key": RADARR_KEY
        }
    });
    const embyApi = axios.create({
        baseURL: `${EMBY_URL}/emby`,
        headers: {
            "X-Emby-Token": EMBY_KEY
        }
    });
            
    app.post('/trailer-request', async (req, res, next) => {
        const body = req.body;
        const user = body.User;
        const item = body.Item;
    
        try {
            if (body.Event === 'system.notificationtest') return res.sendStatus(200);

            if (body.Event !== 'item.rate') return next();
            if (item.Type !== 'Trailer') return next();
            if (!item.UserData.IsFavorite) return next();
    
            log.info(`Received download request for ${item.Name} (${item.ProductionYear})`);
    
            const tmdbId = item.ProviderIds.Tmdb;
            if (!tmdbId) throw `No tmdb ID found for ${item.Name}. Skipping.`;
    
            const movieInfo = (await radarrApi(`/movie/lookup/tmdb?tmdbId=${tmdbId}`)).data;
    
            const qualityProfiles = (await radarrApi('/qualityprofile')).data;
            const selectedProfileId = qualityProfiles.find(profile => profile.name === QUALITY_PROFILE)?.id;
            if (!selectedProfileId) throw `Couldn't associate ${QUALITY_PROFILE} with a quality profile in radarr`;
    
            const tags = (await radarrApi('/tag')).data;
            let dlTag = tags.find(tag => tag.label === `${RADARR_TAG.toLowerCase()}-${user.Name.toLowerCase()}`);
    
            let tagId;
    
            if (!dlTag) {
                tagId = (await radarrApi.post('/tag', {
                    label: `${RADARR_TAG}-${user.Name}`
                })).data.id;
            } else tagId = dlTag.id;
    
            await radarrApi.post('/movie', {
                ...movieInfo,
                tmdbId,
                monitored: true,
                rootFolderPath: ROOT_FOLDER_PATH,
                qualityProfileId: selectedProfileId,
                tags: [tagId],
                addOptions: {
                    searchForMovie: true
                }
            });
    
            log.info(`Successfully added ${item.Name} to radarr`);
    
            sendEmbyMessage(user.Id, `Successfully requested download of "${item.Name} (${item.ProductionYear})". Please wait a while for the download to process.`)
    
            res.sendStatus(200);
        } catch (err) {
            res.sendStatus(500);
    
            if (err?.response?.data[0]?.errorCode === "MovieExistsValidator") {
                log.error(`Failed to download, movie already exists`)
                return sendEmbyMessage(user.Id, "Movie already requested. Try searching for it or check back later.").catch(log.error)
            }
            
            if (err?.response?.data) {
                log.error(err.response.data);
            } else {
                log.error(err);
            }
    
            sendEmbyMessage(user.Id, "Failed to request download. Please try favoriting again.").catch(log.error);
        }
    });
    
    async function sendEmbyMessage(userId, message) {
        return new Promise(async (resolve, reject) => {
            try {
                const sessions = (await embyApi('/Sessions')).data;
                const activeUserSessions = sessions.filter(session =>
                    session.UserId === userId
                    && (new Date() - new Date(session.LastActivityDate)) < 30000
                );
            
                for (const session of activeUserSessions) {
                    await embyApi.post(`/Sessions/${session.Id}/Message?Header=Trailer Download System&Text=${message}`);
                }
    
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }    
}