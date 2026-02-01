import axios from 'axios';
import fs from 'fs';
import ms from 'ms';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { compareVersions, validate } from 'compare-versions';
import { emojify } from 'node-emoji';
import { required } from '../env';

const MAX_MESSAGE_BYTES = 4000;

export const version = "1.4.8";

export const start = async (ctx) => {
    const { log } = ctx;

    const NTFY_URL = required('NTFY_URL');
    const NTFY_AUTH = required('NTFY_AUTH');
    const CHECK_INTERVAL = required('CHECK_INTERVAL');
    const REPO_FILE = required('REPO_FILE');
    const DB_FILE = required('DB_FILE');
    const GH_API_KEY = required('GH_API_KEY'); 

    axios.defaults.headers.common['User-Agent'] = `${pkg.name}/${pkg.version}`;
    axios.defaults.headers.common['Authorization'] = `Bearer ${GH_API_KEY}`;

    const adapter = new JSONFile(DB_FILE);
    const db = new Low(adapter, { releases: {} });

    const initDb = async () => {
        await db.read();
        db.data = db.data || { releases: [] }
        await db.write();
    }

    const updateVersion = async (repo, version) => {
        db.data.releases[repo] = version;
        await db.write();
    }

    const loadRepoLines = (file) => {
        const lines =
            fs.readFileSync(file, 'utf8')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);

        return lines;
    }

    const parseLine = (line) => {
        if (line.startsWith('#')) return { repo: null, beta: false };

        const parts = line.split(':').map(part => part.trim().toLowerCase());
        const repo = parts[0];
        const beta = (parts[1] || '') === 'beta';

        return { repo, beta }
    }

    const fetchReleases = async (repo) => {
        try {
            const releases = (await axios(`https://api.github.com/repos/${repo}/releases`)).data;
            return releases;
        } catch (err) {
            if (err.response.status === 404) {
                log.error(`Repository not found: ${repo}`);
                sendNtfy('Error', 'exclamation', `Repository not found: ${repo}`);
                return;
            }

            throw err;
        }
    }

    const sendNtfy = async (title, tag, message) => {
        await axios.post(NTFY_URL, message, {
            headers: {
                "Title": title,
                "Tags": tag,
                "Markdown": "yes",
                "Authorization": NTFY_AUTH ? `Bearer ${NTFY_AUTH}` : ''
            }
        });
    }

    const githubMarkdown = (text, repo) => {
        const [owner, repoName] = repo.split('/');
        
        // Convert to Github issue/pull requests to #links
        text = text.replace(
            /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/g,
            (_, owner, repo, type, num) => `[#${num}](https://github.com/${owner}/${repo}/${type}/${num})`
        );

        // 2) Replace "Issue: #1185" or just "#1185"
        text = text.replace(
            /(^|[^\w/\[])(?:(issue)\s*:\s*)?#(\d+)\b(?!\]\()/gi,
            (match, prefix, issueWord, num) => {
                const issuePrefix = issueWord ? `${issueWord}: ` : "";
                return `${prefix}${issuePrefix}[#${num}](https://github.com/${owner}/${repoName}/issues/${num})`;
            }
        );

        // Convert @user mentions to Github user links
        text = text.replace(
            /(^|\s)@([a-zA-Z0-9-]+)\b/g,
            (_, prefix, username) => `[${prefix}@${username}](https://github.com/${username})`
        );

        // Convert compare links
        text = text.replace(
            /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/compare\/(v?\d+(?:\.\d+)+)\.\.\.(v?\d+(?:\.\d+)+)/g,
            (match, repo, fromVer, toVer) => `[${fromVer}...${toVer}](${match})`
        );

        // Convert emoji markdown :emoji:
        text = emojify(text);

        return text;
    }

    const trunkateReleaseBody = (body, url, maxBytes) => {
        if (Buffer.byteLength(body, 'utf8') <= maxBytes) {
            return body;
        } else {
            log.debug(`Truncating release notes for ${url}`);

            return `Full release notes: [${url}](${url})`;
        }
    }

    const extractVersion = (str = '') => {
        const match = str.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/);
        return match ? match[1] : null; // strip leading v by only capturing group 1
    };

    const sanitizeVersion = (tag, name) => {
        const sources = [tag, name];

        for (const src of sources) {
            const version = extractVersion(src);
            if (validate(version)) return version;   // e.g. "2.1.0-beta.2"
        }

        return null;
    };

    const processRepoLine = async (line) => {
        const { repo, beta } = parseLine(line);

        if (!repo) return log.debug(`Skipping commented repo line: ${line}`);

        log.debug(`Processing ${repo} - beta: ${beta}`);

        const releases = await fetchReleases(repo);

        let latestRelease = releases.find(release => {
            if (release.draft) return false;
            if (!beta && release.prerelease) return false;

            return true;
        });

        if (!latestRelease) latestRelease = releases.find(release => !release.draft); // If no release found, fall back to allowing beta releases in.....

        if (!latestRelease) return log.info(`No release found for ${repo} - beta: ${beta}`);

        const currentVersion = sanitizeVersion(latestRelease.tag_name, latestRelease.name);
        const name = latestRelease.name;
        const publishedAt = latestRelease.published_at;
        const url = latestRelease.html_url;
        const releaseBody = latestRelease.body || "No release notes.";

        const lastVersion = db.data.releases[repo];
        if (!lastVersion) {
            log.debug(`No previous release found for ${repo} in database. creating entry and skipping notification`);

            await updateVersion(repo, currentVersion);

            return;
        }

        if (!validate(lastVersion) || !currentVersion) return log.error(`Unable to parse versions for ${repo}. ${lastVersion} - last version ${currentVersion} - current version`);

        const compareResult = compareVersions(lastVersion, currentVersion);
        // -1 indicates the "v2" release is greater than "v1"
        if (compareResult === -1) {
            log.info(`New release found for ${repo} - repo: ${repo}`);

            await updateVersion(repo, currentVersion)

            const title = `New release available for ${repo.split('/')[1]}!`;
            const headers = emojify([
                `**${name}**`,
                `Repo: [${repo}](${url})`,
                `Version: ${currentVersion}`,
                `Published: ${new Date(publishedAt).toLocaleString()}`,
                '',
                ''
            ].join('\n'));

            const maxBodyBytes = MAX_MESSAGE_BYTES - Buffer.byteLength(headers, 'utf8');

            const message = headers + trunkateReleaseBody(githubMarkdown(releaseBody, repo), url, maxBodyBytes);

            await sendNtfy(title, 'loudspeaker', message);
        } else if (compareResult === 1) {
            log.info(`Version downgrade on remote repository ${repo} from ${lastVersion} to ${currentVersion}. Updating local database to reflect`);

            await updateVersion(repo, currentVersion)
        } else {
            return log.debug(`Found no increase in version from ${lastVersion} to ${currentVersion} for ${repo}`);
        }
    }

    const checkReleases = async () => {
        try {
            log.info('Performing release check');

            const repoLines = loadRepoLines(REPO_FILE);

            log.info(`Found ${repoLines.length} repos to check...`);

            for (const line of repoLines) {
                await processRepoLine(line).catch(err => log.error(`Failed to process line ${line}`, err));
            }
        } catch (err) {
            log.error(err);
        }

        setTimeout(checkReleases, ms(CHECK_INTERVAL));
    }

    initDb();
    checkReleases();
}