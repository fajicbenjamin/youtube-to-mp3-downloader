const { ffmpegPath, convertToMp3 } = require('./ffmpeg');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const { writeMp3Tags, saveWithoutOverwrite } = require('./mp3-tags');
const deezerApi = require('./deezer-api');
const youtube = require('./youtube');
const { musicTagsFromDetails, lookupMusicTags, searchMusicTags } = require('./youtube-metadata');
const { getCoverImage } = require('./artwork');
const ytdlp = require('./ytdlp');
const fileSystemErrors = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENAMETOOLONG', 'DOWNLOAD_TOOLS_MISSING', 'DOWNLOAD_CANCELLED']);
const activeTracks = new Set();
let stopping = false;

function cancelled() {
    return Object.assign(new Error('Download cancelled.'), { code: 'DOWNLOAD_CANCELLED' });
}

function stopDownloads() {
    stopping = true;
    for (const track of activeTracks) track.controller.abort(cancelled());
}

function safeName(value, fallback = 'Untitled') {
    let name = String(value || '').normalize('NFC')
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ').trim();
    // Keep Unicode titles, but leave room for the extension and duplicate suffix.
    name = Array.from(name).slice(0, 120).join('');
    // Unix filenames are limited in bytes, not characters.
    while (Buffer.byteLength(name, 'utf8') > 180) name = Array.from(name).slice(0, -1).join('');
    name = name.replace(/[. ]+$/g, '');
    if (!name || /^\.+$/.test(name)) return fallback;
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return name;
}

function errorMessage(error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return 'The connection timed out. Please try again.';
    }
    const message = error?.message || 'The download could not be completed.';
    const status = error?.info?.response?.status;
    return status ? `${message} (HTTP ${status})` : message;
}

async function startDownload(params, send) {
    if (stopping) throw cancelled();
    const target = youtube.parseInput(params?.url);
    if (params.coverSearch && !params.coverSearchTitle?.trim()) {
        throw new Error('Enter an artist or song title for the tag search.');
    }
    if (!ffmpegPath) throw new Error('FFmpeg is not available for this platform.');
    send('playlist-status', '');
    send('download-progress', null);
    send('download-status', 'Connecting to YouTube');
    if (!target.playlistId) {
        const track = prepareTrack({ id: target.videoId }, params, app.getPath('downloads'));
        track.activate(send);
        try {
            const result = await track.ready;
            if (result.error) throw result.error;
            await finishTrack(track, result.details);
        } finally {
            await track.dispose();
        }
        return;
    }

    send('download-status', 'Loading playlist');
    const playlist = await ytdlp.getPlaylist(target.playlistId);
    const folderName = safeName(playlist.title, 'YouTube playlist');
    const folder = path.join(app.getPath('downloads'), folderName);
    const total = playlist.entries.length;
    let completed = 0;
    let failed = 0;
    let current;
    let next;
    try {
        for (let index = 0; index < total; index++) {
            if (stopping) throw cancelled();
            const video = playlist.entries[index];
            // Playlist tags always use the automatic lookup, not a single-song override.
            current ||= prepareTrack(video, {}, folder);
            current.activate(send);
            send('playlist-status', `${folderName} · Track ${index + 1} of ${total}`);
            try {
                const result = await current.ready;
                if (result.error) throw result.error;
                // Start just one look-ahead download after this audio is complete.
                // Its UI events stay buffered until this track has finished saving.
                if (index + 1 < total) next = prepareTrack(playlist.entries[index + 1], {}, folder);
                await finishTrack(current, result.details);
                completed++;
            } catch (error) {
                if (fileSystemErrors.has(error.code)) {
                    send('playlist-status', `${completed} saved · Playlist stopped`);
                    throw error;
                }
                failed++;
                send('download-warning', `${video.title}: ${errorMessage(error)}`);
            } finally {
                await current.dispose();
            }
            current = next;
            next = undefined;
        }
    } finally {
        // A storage failure or cancellation must also stop the prefetched track.
        await Promise.all([current?.dispose(), next?.dispose()]);
    }

    if (!total) throw new Error('This playlist is empty or has no accessible videos.');
    send('playlist-status', `${completed} saved${failed ? ` · ${failed} skipped` : ''} · ${folderName}`);
    if (!completed) throw new Error('No tracks could be downloaded. See the skipped tracks below.');
    send('download-progress', 100);
    send('download-status', failed ? 'Playlist finished with skipped tracks' : 'Playlist complete');
}

function prepareTrack(video, params, folder) {
    const controller = new AbortController();
    const { signal } = controller;
    const snapshot = new Map([
        ['show-data', [{ artist: [], cover: '', metadataPending: true }]],
        ['download-status', ['Starting download']],
        ['download-progress', [null]]
    ]);
    let listener;
    let cleanup;
    let tagsStarted = false;
    let reportDetails;
    const videoDetails = new Promise((resolve) => { reportDetails = resolve; });
    const track = {
        video, folder, controller,
        tagsFinished: false, artworkFinished: true,
        tags: Promise.resolve(null), artwork: Promise.resolve(null),
        send(channel, ...args) {
            if (signal.aborted || cleanup) return;
            snapshot.set(channel, args);
            listener?.(channel, ...args);
        },
        activate(send) {
            listener = send;
            for (const [channel, args] of snapshot) send(channel, ...args);
        },
        dispose() {
            if (!cleanup) {
                listener = undefined;
                controller.abort(cancelled());
                cleanup = (async () => {
                    // Wait for yt-dlp to close before removing its output directory.
                    await track.ready;
                    await track.artwork;
                    if (track.temporary) await fsp.rm(track.temporary, { recursive: true, force: true }).catch((error) => {
                        console.warn(`Could not remove temporary files: ${errorMessage(error)}`);
                    });
                    activeTracks.delete(track);
                })();
            }
            return cleanup;
        }
    };
    activeTracks.add(track);
    track.ready = (async () => {
        if (stopping) throw cancelled();
        signal.throwIfAborted();
        if (video.playable === false) throw new Error('This playlist entry is private, deleted, or unavailable.');
        await fsp.mkdir(folder, { recursive: true });
        signal.throwIfAborted();
        track.temporary = await fsp.mkdtemp(path.join(folder, '.yt2mp3-'));
        track.audioPath = path.join(track.temporary, 'source.audio');
        track.mp3Path = path.join(track.temporary, 'output.mp3');
        signal.throwIfAborted();
        const startTags = () => {
            if (tagsStarted || signal.aborted) return;
            tagsStarted = true;
            track.tags = resolveTags(video.id, videoDetails, params, track.send, signal)
                .catch(async (error) => {
                    if (signal.aborted) return null;
                    const details = await videoDetails;
                    if (signal.aborted || !details) return null;
                    console.warn(`${details.title || video.id}: tag lookup failed. ${errorMessage(error)}`);
                    return titleOnlyTags(details.title || video.id);
                }).then((tags) => {
                    if (signal.aborted) return null;
                    if (tags?.cover) {
                        // Fetch the winning artwork immediately, alongside the audio.
                        // Only the bounded image is buffered; never the whole MP3.
                        track.artworkFinished = false;
                        track.artwork = getCoverImage(tags.cover, signal).catch((error) => {
                            if (!signal.aborted) console.warn(`${tags.title}: artwork unavailable. ${errorMessage(error)}`);
                            return null;
                        }).finally(() => { track.artworkFinished = true; });
                    }
                    if (tags) track.send('show-data', tags);
                    return tags;
                }).catch((error) => {
                    if (!signal.aborted) console.warn(`Could not prepare song tags: ${errorMessage(error)}`);
                    return null;
                }).finally(() => { track.tagsFinished = true; });
        };
        const details = await ytdlp.downloadAudio(video.id, track.audioPath, ffmpegPath, track.send, reportDetails, signal, startTags);
        reportDetails(details);
        return details;
    })().then((details) => ({ details }), (error) => {
        // Prefetch can fail before it becomes visible. Store its result instead
        // of leaving a rejected promise unhandled or changing the current card.
        controller.abort(error);
        reportDetails(null);
        return { error };
    });
    return track;
}

async function finishTrack(track, details) {
    const { signal } = track.controller;
    const send = track.send;
    // Metadata and image fetching do not delay the start of conversion.
    await convertToMp3(track.audioPath, track.mp3Path, Number(details.duration), send, signal);
    await fsp.rm(track.audioPath, { force: true }).catch((error) => {
        console.warn(`Could not remove converted source audio: ${errorMessage(error)}`);
    });
    if (!track.tagsFinished) send('download-status', 'Finishing MP3 tag lookup');
    const songData = await track.tags || titleOnlyTags(details.title || track.video.id);
    signal.throwIfAborted();
    send('show-data', songData);
    if (!track.artworkFinished) send('download-status', 'Finishing cover artwork');
    const cover = await track.artwork;
    signal.throwIfAborted();
    const title = songData.artist.length ? `${songData.artist.join(', ')} - ${songData.title}` : songData.title;
    send('download-status', songData.source ? `Writing MP3 tags from ${songData.source}` : 'Writing MP3 title');
    try {
        await writeMp3Tags(track.mp3Path, songData, cover, signal);
    } catch (error) {
        signal.throwIfAborted();
        if (fileSystemErrors.has(error.code)) throw error;
        console.warn(`${title}: could not write MP3 tags. ${errorMessage(error)}`);
    }
    const savedPath = await saveWithoutOverwrite(track.mp3Path, track.folder, safeName(title, track.video.id), signal);
    send('download-progress', 100);
    send('download-status', 'Done', title, savedPath);
}

function titleOnlyTags(title) {
    return { title, artist: [], album: '', cover: '', metadataStatus: 'No music match found · Title only' };
}

async function resolveTags(videoId, videoDetails, params, send, signal) {
    const showLookup = (metadataStatus) => send('show-data', {
        artist: [], cover: '', metadataPending: true, metadataStatus
    });
    // yt-dlp emits details before the audio transfer. Wait for that existing
    // result before opening a Music session, without blocking the download.
    // An explicit custom search can still start immediately.
    const details = params.coverSearch ? null : await videoDetails;
    signal.throwIfAborted();
    if (!params.coverSearch && !details) return null;
    // A custom search is an explicit override, including when YouTube Music
    // already knows this track. Playlists pass their own default parameters.
    if (!params.coverSearch) {
        const extractedTags = musicTagsFromDetails(details);
        if (extractedTags) return extractedTags;
        showLookup('Checking YouTube Music');
        let client;
        try {
            // YouTube.js is optional metadata only. A failed session must never
            // prevent yt-dlp from downloading or Deezer from supplying tags.
            client = await youtube.getClient();
            signal.throwIfAborted();
            const { tags } = await lookupMusicTags(client, videoId, signal);
            signal.throwIfAborted();
            if (tags) return tags;
        } catch (error) {
            signal.throwIfAborted();
            // Optional metadata failures stay out of Download notes.
            console.warn(`YouTube Music lookup failed: ${errorMessage(error)}`);
        }
        if (client) {
            showLookup('Searching YouTube Music');
            try {
                const { tags } = await searchMusicTags(client, details, signal);
                signal.throwIfAborted();
                if (tags) return tags;
            } catch (error) {
                signal.throwIfAborted();
                console.warn(`YouTube Music search failed: ${errorMessage(error)}`);
            }
        }
    }

    signal.throwIfAborted();
    showLookup('Looking up Deezer');
    const videoTitle = details?.title || videoId;
    // Apply the legacy title cleanup only to automatic Deezer searches.
    const query = params.coverSearch ? params.coverSearchTitle.trim() : videoTitle
        .replace(/ *\([^)]*\) */g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\b(official|music video|lyrics?|audio|video|hd|hq|\d+k)\b/gi, ' ')
        .replace(/[^A-Za-z0-9 ]/g, '')
        .replace(/feat|feat.|ft.|[0-9]k|hd/ig, '')
        .replace(/(?<=^| ).(?=$| )/g, '')
        .replace(/\s+/g, ' ').trim();
    const tags = await deezerApi.getSongData(query || videoTitle, signal);
    signal.throwIfAborted();
    if (tags) return { ...tags, source: 'Deezer' };

    // Preserve useful basic tags even without a catalog match. Do not guess
    // the artist from the uploading channel or use a video thumbnail as cover.
    const fallbackDetails = details || await videoDetails;
    signal.throwIfAborted();
    return fallbackDetails ? titleOnlyTags(fallbackDetails.title || videoId) : null;
}

module.exports = { startDownload, errorMessage, stopDownloads };
