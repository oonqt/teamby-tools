import { qBittorrentClient } from '@robertklep/qbittorrent';
import axios from 'axios';
import ip from 'ip';
import { required, optional } from '../env.js';

export const version = "1.3.2";

export const start = (ctx) => {
    const { log } = ctx;

    const EMBY_URL = required('EMBY_URL');
    const EMBY_API_KEY = required('EMBY_API_KEY');
    const QBIT_HOST = required('QBIT_HOST');
    const QBIT_USER = required('QBIT_USER');
    const QBIT_PASS = required('QBIT_PASS');
    const POLL_INTERVAL = optional('POLL_INTERVAL', 10);
    const LOCAL_SUBNET = required('LOCAL_SUBNET');
    
    const qbitClient = new qBittorrentClient(QBIT_HOST, QBIT_USER, QBIT_PASS);
    const embyClient = axios.create({
        baseURL: `${EMBY_URL}/emby`,
        headers: {
            "X-Emby-Token": EMBY_API_KEY
        }
    });
    
    const isLocalIP = (addr, subnet) => ip.cidrSubnet(subnet).contains(addr) || ip.isLoopback(addr);
    
    const main = async () => {
        log.debug('Checking for sessions....');    
    
        try {
            const downloads = (await embyClient('/Sync/Jobs')).data;
            const downloadsInTransfer = downloads.Items.filter(download => download.Status === "Transferring");
            const sessions = (await embyClient('/Sessions')).data;
            const usingAltSpeeds = Boolean(Number(await qbitClient.transfer.speedLimitsMode()));
    
            let remoteDownload = null;
    
            for (const download of downloadsInTransfer) {
                const session = sessions.find(session => session.DeviceId === download.TargetId);
                if (!session) {
                    log.info(`No session found for device ${download.TargetName} (${download.TargetId})`);
                } else if (!isLocalIP(session.RemoteEndPoint, LOCAL_SUBNET)) {
                    remoteDownload = download;
                }
            }
    
            const limit = await qbitClient.transfer.uploadLimit();
    
            if (remoteDownload && limit != 1024) {
                log.info(`Detected remote download from ${remoteDownload.TargetName} (${remoteDownload.TargetId}), enabling seedblocker`);
    
                if (usingAltSpeeds) await qbitClient.transfer.toggleSpeedLimitsMode();
    
                await qbitClient.transfer.setUploadLimit(1024);
            } else if (!remoteDownload && limit == 1024) {
                log.info('Remote download no longer transferring, disabling seed block');
    
                await qbitClient.transfer.setUploadLimit(0);
            } else if (!remoteDownload) {
                const remoteSessions = sessions.filter(session => {
                    const remoteIp = session.RemoteEndPoint;
                    
                    return session.NowPlayingItem
                        && !session.PlayState.MediaSourceId.startsWith('local:')
                        && session.NowPlayingItem.Type !== 'Audio'
                        && !isLocalIP(remoteIp, LOCAL_SUBNET)
                });
        
                log.debug(`usingAltSpeeds: ${usingAltSpeeds}, totalSessions: ${sessions.length}, remoteSessions: ${remoteSessions.length}`)
            
                if (remoteSessions.length && !usingAltSpeeds) {
                    log.info('Remote session detected, enabling alternative speeds.');
            
                    await qbitClient.transfer.toggleSpeedLimitsMode();
                } else if (!remoteSessions.length && usingAltSpeeds) {
                    log.info('All remote sessions closed, disabling alternative speeds.');
        
                    await qbitClient.transfer.toggleSpeedLimitsMode();
                }
            }
        } catch (err) {
            log.error(err);
        }
    
        setTimeout(main, POLL_INTERVAL * 1000);
    }
        
    main();
}