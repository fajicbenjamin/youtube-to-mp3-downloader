const { app } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const releases = require('./downloader-binaries.json');
const { spawnTool, stopChild, isToolRunningIn } = require('./tool-processes');
const { installRuntime, verifyRuntime } = require('./downloader-runtime');

const CHANNEL = 'nightly';
const REPOSITORY = 'yt-dlp/yt-dlp-nightly-builds';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const RELEASE_DIRECTORY = /^release-[a-f0-9-]{36}$/;
const VERSION = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)*$/;
const HASH = /^[a-f0-9]{64}$/;
let statePromise;
let bundledPromise;
let toolsPromise;
let state;
let stateWrites = Promise.resolve();
let operation;
let onStatus = () => {};
let stopping = false;
const requests = new Set();
const verified = new Map();
const unusableDirectories = new Set();
let status = { version: releases.ytDlp.version, source: 'bundled', busy: false, message: '' };

const target = () => `${process.platform}-${process.arch}`;
const filename = () => process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const root = () => path.join(app.getPath('userData'), 'download-engine', target());
const stateFile = () => path.join(root(), 'state.json');
const releasePath = (entry) => entry.layout === 'directory'
    ? path.join(root(), entry.directory, 'runtime', entry.executable)
    : path.join(root(), entry.directory, filename());

function validEntry(entry) {
    return entry && RELEASE_DIRECTORY.test(entry.directory) && VERSION.test(entry.version) && HASH.test(entry.sha256) &&
        (entry.layout === undefined || (entry.layout === 'directory' &&
            releases.ytDlp.assets[target()]?.layout === 'directory' &&
            entry.executable === releases.ytDlp.assets[target()].executable && HASH.test(entry.manifestSha256)));
}

function publish(patch) {
    status = { ...status, ...patch };
    onStatus({ ...status });
}

function subscribe(listener) {
    onStatus = listener;
    onStatus({ ...status });
}

async function loadState() {
    if (!statePromise) statePromise = (async () => {
        let saved = {};
        try { saved = JSON.parse(await fsp.readFile(stateFile(), 'utf8')); } catch { /* First run or interrupted write. */ }
        state = {
            active: validEntry(saved?.active) ? saved.active : null,
            previous: validEntry(saved?.previous) ? saved.previous : null,
            blocked: Array.isArray(saved?.blocked) ? saved.blocked.filter((value) => HASH.test(value)).slice(-8) : [],
            lastAttempt: Number(saved?.lastAttempt) || 0,
            lastCheck: Number(saved?.lastCheck) || 0
        };
        return state;
    })();
    await statePromise;
    return state;
}

function saveState(change) {
    stateWrites = stateWrites.catch(() => {}).then(async () => {
        const next = change(await loadState());
        await fsp.mkdir(root(), { recursive: true });
        const temporary = `${stateFile()}.${randomUUID()}.tmp`;
        try {
            await fsp.writeFile(temporary, JSON.stringify(next, null, 2));
            await fsp.rename(temporary, stateFile());
            state = next;
        } finally {
            await fsp.rm(temporary, { force: true }).catch(() => {});
        }
    });
    return stateWrites;
}

async function hashFile(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

function compareVersions(a, b) {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const difference = (left[i] || 0) - (right[i] || 0);
        if (difference) return difference;
    }
    return 0;
}

function bundledTools() {
    // Installed app resources are fixed for this session. Validate once; a
    // failed setup remains retryable and process-launch errors still surface.
    if (!bundledPromise) bundledPromise = readBundledTools().catch((error) => {
        bundledPromise = undefined;
        throw error;
    });
    return bundledPromise;
}

async function readBundledTools() {
    const directory = app.isPackaged ? path.join(process.resourcesPath, 'downloader')
        : path.join(__dirname, '..', 'vendor', 'downloader', target());
    let ytDlp = path.join(directory, filename());
    let layout;
    try {
        const manifest = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        if (manifest.target !== target() || manifest.ytDlp !== releases.ytDlp.version) {
            throw new Error('Download tools do not match this app version.');
        }
        if (manifest.layout === 'directory') {
            const asset = releases.ytDlp.assets[target()];
            if (asset?.layout !== 'directory' || manifest.executable !== asset.executable || manifest.sha256 !== asset.sha256) {
                throw new Error('The bundled runtime does not match this platform.');
            }
            ytDlp = await verifyRuntime(directory, manifest);
            layout = 'directory';
        }
        const access = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
        await fsp.access(ytDlp, access);
    } catch {
        const error = new Error(app.isPackaged
            ? 'The bundled download tools are missing or outdated. Please reinstall the app.'
            : 'Download tools are missing or outdated. Run npm run setup:downloader, then restart the app.');
        error.code = 'DOWNLOAD_TOOLS_MISSING';
        throw error;
    }
    return { ytDlp, jsRuntime: process.execPath, layout, version: releases.ytDlp.version, entry: null };
}

async function usableEntry(entry) {
    if (!validEntry(entry) || unusableDirectories.has(entry.directory) || compareVersions(entry.version, releases.ytDlp.version) < 0) return false;
    try {
        if (entry.layout === 'directory') {
            await verifyRuntime(path.join(root(), entry.directory), entry);
            return true;
        }
        const file = releasePath(entry);
        const info = await fsp.stat(file);
        if (!info.isFile() || !info.size) return false;
        const signature = `${entry.sha256}:${info.size}:${info.mtimeMs}`;
        if (verified.get(file) !== signature) {
            if (await hashFile(file) !== entry.sha256) return false;
            verified.set(file, signature);
        }
        await fsp.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
    } catch { return false; }
}

function getTools() {
    // Startup checks and a newly queued download can overlap. Share their
    // verification work without caching the selected release across updates.
    if (!toolsPromise) toolsPromise = selectTools().finally(() => { toolsPromise = undefined; });
    return toolsPromise;
}

async function selectTools() {
    const bundled = await bundledTools();
    const current = await loadState();
    if (await usableEntry(current.active)) {
        publish({ version: current.active.version, source: CHANNEL });
        return { ...bundled, ytDlp: releasePath(current.active), layout: current.active.layout, version: current.active.version, entry: current.active };
    }
    if (current.active) {
        await rejectRelease(current.active).catch(() => {});
        const fallback = await loadState();
        if (await usableEntry(fallback.active)) {
            publish({ version: fallback.active.version, source: CHANNEL });
            return { ...bundled, ytDlp: releasePath(fallback.active), layout: fallback.active.layout, version: fallback.active.version, entry: fallback.active };
        }
    }
    publish({ version: bundled.version, source: 'bundled' });
    return bundled;
}

async function rejectRelease(entry) {
    // Preserve the fallback in this session even if saving preferences fails
    // (for example, the disk filled up after this engine was downloaded).
    unusableDirectories.add(entry.directory);
    const current = await loadState();
    if (current.active?.directory !== entry.directory) return;
    const previous = await usableEntry(current.previous) ? current.previous : null;
    await saveState((latest) => latest.active?.directory !== entry.directory ? latest : {
        ...latest, active: previous, previous: null,
        blocked: [...new Set([...latest.blocked, entry.sha256])].slice(-8)
    });
    publish({ version: previous?.version || releases.ytDlp.version, source: previous ? CHANNEL : 'bundled',
        message: 'The updated engine was unavailable; using the previous version.' });
}

async function request(url, consume, timeout = 15000) {
    if (stopping) throw new Error('App is closing.');
    const controller = new AbortController();
    requests.add(controller);
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'YouTube-to-MP3-Downloader', Accept: 'application/vnd.github+json' },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)])
        });
        if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
        return await consume(response);
    } finally {
        controller.abort();
        requests.delete(controller);
    }
}

async function readText(response, limit = 2 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
        size += chunk.length;
        if (size > limit) throw new Error('Update metadata is too large.');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function releaseInfo() {
    const info = await request(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, async (response) => JSON.parse(await readText(response)));
    if (info.draft || !VERSION.test(info.tag_name)) throw new Error('GitHub did not return a valid nightly release.');
    const platformAsset = releases.ytDlp.assets[target()];
    const assetName = platformAsset?.name;
    const asset = info.assets?.find((item) => item.name === assetName);
    if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 256 * 1024 * 1024) {
        throw new Error('No compatible download engine was found for this platform.');
    }
    const base = `https://github.com/${REPOSITORY}/releases/download/${info.tag_name}`;
    let sha256 = String(asset.digest || '').replace(/^sha256:/, '');
    if (!HASH.test(sha256)) {
        const sums = await request(`${base}/SHA2-256SUMS`, (response) => readText(response));
        sha256 = sums.split(/\r?\n/).map((line) => line.trim().split(/\s+\*?/))
            .find((parts) => parts[1] === assetName)?.[0] || '';
    }
    if (!HASH.test(sha256)) throw new Error('The update has no valid SHA-256 checksum.');
    const sourceCommit = String(info.body || '').match(/https:\/\/github\.com\/yt-dlp\/yt-dlp\/commit\/([a-f0-9]{40})(?![a-f0-9])/i)?.[1];
    if (!sourceCommit) throw new Error('The nightly release is missing its source revision. Keeping the installed engine.');
    return { version: info.tag_name, sourceCommit, sha256, size: asset.size, url: `${base}/${assetName}`,
        layout: platformAsset.layout, executable: platformAsset.executable };
}

async function saveReleaseNotices(release, folder) {
    const source = `https://github.com/yt-dlp/yt-dlp/tree/${release.sourceCommit}`;
    const texts = await Promise.all(['LICENSE', 'THIRD_PARTY_LICENSES.txt'].map(async (name) => ({ name,
        text: await request(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${release.sourceCommit}/${name}`, readText) })));
    if (texts.some((item) => !item.text.trim() || /^\s*</.test(item.text))) throw new Error('Invalid engine license document.');
    // The upstream third-party notices include the GPL text; ffmpeg-static also
    // ships it in LICENSE. No separate app-owned GPL snapshot is needed.
    const notices = { name: 'yt-dlp (selected nightly)', version: release.version,
        license: 'GPL-3.0-or-later binary; Unlicense source; additional component licenses',
        links: [{ label: 'Exact nightly release', url: `https://github.com/${REPOSITORY}/releases/tag/${release.version}` },
            { label: 'Release source archive', url: `https://github.com/${REPOSITORY}/releases/download/${release.version}/yt-dlp.tar.gz` },
            { label: 'Exact source revision and build scripts', url: source }], texts };
    await fsp.writeFile(path.join(folder, 'licenses.json'), JSON.stringify(notices));
}

async function getReleaseNotices(version) {
    try {
        const current = await loadState();
        const entry = [current.active, current.previous].find((item) => item?.version === version);
        if (!entry || !RELEASE_DIRECTORY.test(entry.directory)) return null;
        const file = path.join(root(), entry.directory, 'licenses.json');
        const info = await fsp.lstat(file);
        if (!info.isFile() || info.size > 5 * 1024 * 1024) return null;
        const notices = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (notices.version !== version || typeof notices.name !== 'string' || typeof notices.license !== 'string' ||
            !Array.isArray(notices.links) || !notices.links.every((item) => typeof item?.label === 'string' && typeof item?.url === 'string') ||
            !Array.isArray(notices.texts) || !notices.texts.length || !notices.texts.every((item) => typeof item?.name === 'string' && typeof item?.text === 'string')) return null;
        return notices;
    } catch { return null; }
}

function readVersion(file) {
    return new Promise((resolve, reject) => {
        if (stopping) return reject(new Error('App is closing.'));
        const child = spawnTool(file, ['--ignore-config', '--no-plugin-dirs', '--no-update', '--version']);
        let output = '';
        let failure;
        const timer = setTimeout(() => {
            failure = new Error('The new download engine did not start in time.');
            stopChild(child);
        }, 30000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-1000); });
        child.stderr.resume();
        child.on('error', (error) => { failure = error; });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (failure || code !== 0 || !VERSION.test(output.trim())) reject(failure || new Error('The new download engine could not start.'));
            else resolve(output.trim());
        });
    });
}

async function removeRelease(directory) {
    // Only our generated release directories immediately inside this target's
    // update directory can be removed. Never follow paths from remote metadata.
    if (!RELEASE_DIRECTORY.test(directory)) return;
    const folder = path.resolve(root(), directory);
    if (path.dirname(folder) !== path.resolve(root()) || isToolRunningIn(folder)) return;
    await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
}

async function cleanup() {
    const current = await loadState();
    const keep = new Set([current.active?.directory, current.previous?.directory]);
    const entries = await fsp.readdir(root()).catch(() => []);
    for (const entry of entries) if (!keep.has(entry)) await removeRelease(entry);
}

async function performUpdate(force) {
    const current = await loadState();
    const now = Date.now();
    if (!force && ((now >= current.lastCheck && now - current.lastCheck < DAY)
        || (now >= current.lastAttempt && now - current.lastAttempt < HOUR))) return;
    let directory;
    const controller = new AbortController();
    requests.add(controller);
    try {
        publish({ busy: true, message: 'Checking for a yt-dlp update…' });
        const tools = await getTools();
        await saveState((latest) => ({ ...latest, lastAttempt: now }));
        await cleanup();
        const release = await releaseInfo();
        const comparison = compareVersions(release.version, tools.version);
        const sameVersionMigration = comparison === 0 && release.layout === 'directory' && tools.layout !== 'directory';
        if ((!force && state.blocked.includes(release.sha256)) || comparison < 0 || (comparison === 0 && !sameVersionMigration)) {
            if (comparison === 0 && tools.entry && !(await getReleaseNotices(tools.version))) {
                await saveReleaseNotices(release, path.join(root(), tools.entry.directory));
            }
            await saveState((latest) => ({ ...latest, lastCheck: Date.now() }));
            publish({ message: state.blocked.includes(release.sha256) ? 'Keeping the previous engine until a newer nightly is available.' : 'yt-dlp is up to date.' });
            return;
        }
        publish({ message: `Downloading yt-dlp ${release.version}…` });
        directory = `release-${randomUUID()}`;
        const folder = path.join(root(), directory);
        await fsp.mkdir(folder, { recursive: true });
        const assetFile = path.join(folder, release.layout === 'directory' ? 'download.zip' : filename());
        const hash = createHash('sha256');
        let size = 0;
        await request(release.url, (response) => pipeline(Readable.fromWeb(response.body), new Transform({
            transform(chunk, encoding, callback) {
                size += chunk.length;
                if (size > release.size) return callback(new Error('Update download is larger than expected.'));
                hash.update(chunk);
                callback(null, chunk);
            }
        }), fs.createWriteStream(assetFile, { flags: 'wx' })), 180000);
        if (size !== release.size || hash.digest('hex') !== release.sha256) throw new Error('Update checksum verification failed.');
        let file = assetFile;
        let runtime = {};
        if (release.layout === 'directory') {
            publish({ message: 'Preparing the updated engine…' });
            const manifestSha256 = await installRuntime(assetFile, folder, release.executable, release.sha256, controller.signal);
            runtime = { layout: 'directory', executable: release.executable, manifestSha256 };
            file = path.join(folder, 'runtime', release.executable);
            await fsp.rm(assetFile);
        }
        if (process.platform !== 'win32') await fsp.chmod(file, 0o755);
        publish({ message: 'Checking the updated engine…' });
        try {
            if (await readVersion(file) !== release.version) throw new Error('The downloaded engine reports an unexpected version.');
        } catch (error) {
            // Avoid repeatedly downloading an incompatible nightly on this OS.
            // A deliberate manual check can retry it; a newer build is allowed.
            if (!stopping) await saveState((latest) => ({ ...latest,
                blocked: [...new Set([...latest.blocked, release.sha256])].slice(-8), lastCheck: Date.now() }));
            throw error;
        }
        await saveReleaseNotices(release, folder);
        if (stopping) throw new Error('App is closing.');
        const entry = { directory, version: release.version, sha256: release.sha256, ...runtime };
        await saveState((latest) => ({ ...latest, previous: latest.active, active: entry, lastCheck: Date.now(),
            blocked: latest.blocked.filter((value) => value !== release.sha256) }));
        directory = null;
        publish({ version: entry.version, source: CHANNEL, message: 'yt-dlp updated. Ready for the next download.' });
        await cleanup();
    } catch (error) {
        if (!stopping) publish({ message: `Update unavailable; keeping the installed engine. ${error.message}` });
    } finally {
        requests.delete(controller);
        if (directory) await removeRelease(directory);
        publish({ busy: false });
    }
}

function checkForUpdates({ force = false } = {}) {
    if (stopping) return Promise.resolve();
    if (!operation) operation = performUpdate(force).finally(() => { operation = null; });
    return operation;
}

async function performRestore() {
    const bundled = await bundledTools();
    await saveState((latest) => ({ ...latest, active: null, previous: null,
        blocked: [...new Set([...latest.blocked, latest.active?.sha256].filter(Boolean))].slice(-8) }));
    publish({ version: bundled.version, source: 'bundled', message: 'Bundled yt-dlp restored. The replaced update will be skipped automatically.' });
    await cleanup();
}

function restoreBundled() {
    if (stopping || operation) return operation || Promise.resolve();
    operation = performRestore().finally(() => { operation = null; });
    return operation;
}

function stopUpdates() {
    stopping = true;
    for (const controller of requests) controller.abort();
}

module.exports = { getTools, rejectRelease, checkForUpdates, restoreBundled, subscribe, stopUpdates };
