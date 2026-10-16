const { app } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const engine = require('./download-engine');
const { spawnTool, stopChild } = require('./tool-processes');

const VIDEO_PREFIX = '__YT2MP3_VIDEO__';
const FORMAT_PREFIX = '__YT2MP3_FORMAT__';
const PROGRESS_PREFIX = '__YT2MP3_PROGRESS__';
const FILE_PREFIX = '__YT2MP3_FILE__';
const VIDEO_FIELDS = 'id,title,track,artist,artists,album,description,thumbnail,thumbnails,duration,live_status,acodec,abr,tbr,format_id,language';
let cacheDirectory;

function prepareCache() {
    if (!cacheDirectory) {
        const directory = path.join(app.getPath('userData'), 'yt-dlp-cache');
        cacheDirectory = fsp.mkdir(directory, { recursive: true }).then(() => directory).catch((error) => {
            cacheDirectory = undefined;
            throw error;
        });
    }
    return cacheDirectory;
}

async function run(args, onLine, cwd, signal, { mayFallback = true, onStarted } = {}) {
    signal?.throwIfAborted();
    // These independent filesystem preparations used to run sequentially for
    // every track. Create the cache once and select the engine concurrently.
    const [tools, cache] = await Promise.all([engine.getTools(), prepareCache()]);
    signal?.throwIfAborted();
    try {
        return await runWithTools(tools, args, onLine, cwd, signal, cache, onStarted);
    } catch (error) {
        // Retry only launch failures with a known fallback. A YouTube 403 or a
        // network failure is not evidence that a new executable is broken.
        if (signal?.aborted || !mayFallback || !tools.entry || error.code !== 'DOWNLOAD_TOOLS_MISSING') throw error;
        await engine.rejectRelease(tools.entry).catch(() => {});
        return run(args, onLine, cwd, signal, { mayFallback: false, onStarted });
    }
}

async function runWithTools({ ytDlp, jsRuntime }, args, onLine, cwd, signal, cache, onStarted) {
    const commonArgs = [
        '--ignore-config', '--no-plugin-dirs', '--no-update', '--no-remote-components',
        // Inputs are normalized to YouTube watch/playlist URLs by this app.
        '--use-extractors', 'youtube.*',
        '--extractor-args', 'youtube:skip=translated_subs',
        '--no-js-runtimes', '--js-runtimes', `node:${jsRuntime}`,
        '--cache-dir', cache, '--encoding', 'utf-8', '--color', 'never',
        '--socket-timeout', '20', '--extractor-retries', '2', '--retries', '3', '--fragment-retries', '3'
    ];

    // Only this subprocess tree gets Node mode. The running Electron UI keeps
    // its normal environment; yt-dlp's Node children inherit this scoped one.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
        'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'ELECTRON_NO_ATTACH_CONSOLE',
        'YTDLP_NO_LAZY_EXTRACTORS'
    ].includes(name.toUpperCase())));
    Object.assign(env, { PYTHONUTF8: '1', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' });
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawnTool(ytDlp, [...commonArgs, ...args], {
            cwd: cwd || app.getPath('userData'),
            env
        });
        child.once('spawn', () => {
            // Optional metadata imports start only after the OS has launched
            // the downloader. They must never prevent that launch.
            try { onStarted?.(); }
            catch (error) { console.warn(`Could not start background tag lookup: ${error.message}`); }
        });
        const stderr = [];
        let failure;
        let timer;
        const fail = (error) => {
            if (!failure) failure = error;
            stopChild(child);
        };
        const abort = () => fail(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        const armTimeout = () => {
            clearTimeout(timer);
            timer = setTimeout(() => fail(new Error('YouTube stopped responding for two minutes. Please try again.')), 120000);
            timer.unref();
        };
        armTimeout();
        const consume = (line, isError) => {
            armTimeout();
            try {
                if (line.length > 32 * 1024 * 1024) throw new Error('YouTube returned too much playlist data. Try a smaller playlist.');
                if (failure || onLine(line)) return;
                if (isError && line.trim()) {
                    stderr.push(line.slice(0, 4000));
                    if (stderr.length > 20) stderr.shift();
                }
            } catch (error) { fail(error); }
        };
        const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        const errors = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
        output.on('line', (line) => consume(line, false));
        errors.on('line', (line) => consume(line, true));
        output.on('error', fail);
        errors.on('error', fail);
        child.on('error', (error) => {
            failure = new Error(`Could not start yt-dlp: ${error.message}`);
            failure.code = 'DOWNLOAD_TOOLS_MISSING';
        });
        child.on('close', (code, exitSignal) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            output.close();
            errors.close();
            if (!failure && code !== 0) {
                const errorLines = stderr.filter((line) => line.startsWith('ERROR:'));
                const detail = (errorLines.length ? errorLines : stderr).slice(-4).join('\n');
                failure = new Error(detail || `yt-dlp stopped (${exitSignal || `exit ${code}`}).`);
                // Let playlist processing stop on local storage failures.
                if (/No space left|disk.{0,20}full|Errno 28/i.test(detail)) failure.code = 'ENOSPC';
                else if (/Permission denied|Access is denied|Errno 13/i.test(detail)) failure.code = 'EACCES';
                else if (/Read-only file system/i.test(detail)) failure.code = 'EROFS';
            }
            if (failure) reject(failure);
            else resolve();
        });
    });
}

async function getPlaylist(playlistId) {
    let playlist;
    await run([
        // Keep page-loading messages flowing so a large playlist doesn't hit
        // the inactivity timeout while yt-dlp collects its final JSON result.
        '--flat-playlist', '--dump-single-json', '--skip-download', '--yes-playlist', '--no-quiet',
        '--', `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`
    ], (line) => {
        if (!line.startsWith('{')) return false;
        playlist = JSON.parse(line);
        return true;
    });
    if (!Array.isArray(playlist?.entries)) throw new Error('YouTube did not return a readable playlist.');
    return {
        title: playlist.title || 'YouTube playlist',
        entries: playlist.entries.map((entry) => ({
            id: entry?.id,
            title: entry?.title || 'Unavailable video',
            playable: /^[a-zA-Z0-9_-]{11}$/.test(entry?.id || '') && !['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(entry?.availability)
        }))
    };
}

async function downloadAudio(videoId, audioPath, ffmpegPath, send, onDetails, signal, onStarted) {
    let details;
    let completedPath;
    let lastProgress = -1;
    let preparationStage = 0;
    let audioStarted = false;
    const preparing = (stage, message) => {
        if (stage <= preparationStage) return;
        preparationStage = stage;
        send('download-status', message);
    };
    await run([
        '--no-playlist', '--no-simulate', '--format', 'bestaudio', '--format-sort', 'lang,quality,abr,asr',
        '--match-filters', 'live_status != is_live & live_status != is_upcoming & live_status != post_live',
        '--no-wait-for-video', '--concurrent-fragments', '4', '--abort-on-unavailable-fragments',
        '--ffmpeg-location', ffmpegPath, '--fixup', 'never',
        // --print otherwise hides extraction activity. Keep normal output so
        // the UI can show preparation stages before the first audio bytes.
        '--output', 'source.audio', '--no-quiet', '--newline', '--progress', '--progress-delta', '0.5',
        '--print', `pre_process:${VIDEO_PREFIX}%(.{${VIDEO_FIELDS}})j`,
        '--print', `before_dl:${FORMAT_PREFIX}%(.{${VIDEO_FIELDS}})j`,
        '--print', `after_move:${FILE_PREFIX}%(filepath)j`,
        '--progress-template', `download:${PROGRESS_PREFIX}%(progress.{status,downloaded_bytes,total_bytes,total_bytes_estimate,fragment_index,fragment_count})j`,
        '--', `https://www.youtube.com/watch?v=${videoId}`
    ], (line) => {
        if (line.startsWith(VIDEO_PREFIX) || line.startsWith(FORMAT_PREFIX)) {
            const isFormat = line.startsWith(FORMAT_PREFIX);
            details = JSON.parse(line.slice(isFormat ? FORMAT_PREFIX.length : VIDEO_PREFIX.length));
            if (['is_live', 'is_upcoming', 'post_live'].includes(details.live_status)) {
                throw new Error('This broadcast is live, upcoming, or still processing. Try again after YouTube finishes processing it.');
            }
            // Reuse extracted music tags before starting any optional lookup.
            // Metadata resolution alone controls the card's title and artwork.
            onDetails?.(details);
            if (isFormat) {
                preparing(4, 'Starting audio download');
            }
            return true;
        }
        if (line.startsWith(PROGRESS_PREFIX)) {
            const progress = JSON.parse(line.slice(PROGRESS_PREFIX.length));
            if (!audioStarted && Number(progress.downloaded_bytes) > 0) {
                audioStarted = true;
                preparing(5, 'Downloading audio');
            }
            const total = Number(progress.total_bytes || progress.total_bytes_estimate);
            const fraction = total > 0 ? Number(progress.downloaded_bytes) / total
                : progress.fragment_count > 0 ? Number(progress.fragment_index) / progress.fragment_count : NaN;
            const value = Number.isFinite(fraction) ? Math.min(49, Math.max(0, Math.floor(fraction * 50))) : null;
            if (value !== lastProgress) {
                send('download-progress', value);
                lastProgress = value;
            }
            return true;
        }
        if (line.startsWith(FILE_PREFIX)) {
            completedPath = JSON.parse(line.slice(FILE_PREFIX.length));
            return true;
        }
        // These messages are presentation hints only. Metadata, completion,
        // and byte progress still come exclusively from the structured events.
        if (line.startsWith('[youtube]')) {
            if (/\[jsc:|Solving .*challenges|Downloading player [^ ]/i.test(line)) {
                preparing(3, 'Preparing audio access');
            } else if (/Downloading (?:webpage|.*player API JSON)/i.test(line)) {
                preparing(2, 'Reading video information');
            } else if (/Extracting URL/i.test(line)) {
                preparing(1, 'Connecting to YouTube');
            }
            return true;
        }
        return false;
    }, path.dirname(audioPath), signal, { onStarted });

    // Exit success alone also occurs when a filter skips a video. Require both
    // the completion event and a nonempty file before starting MP3 conversion.
    if (!details || typeof completedPath !== 'string' || path.resolve(path.dirname(audioPath), completedPath) !== path.resolve(audioPath)) {
        throw new Error('YouTube did not provide a complete audio download. Live and still-processing videos cannot be saved yet.');
    }
    const audio = await fsp.stat(audioPath);
    if (!audio.isFile() || !audio.size) throw new Error('The downloaded audio file is empty.');
    send('download-progress', 50);
    return details;
}

module.exports = { downloadAudio, getPlaylist };
