const { fetchWithTimeout } = require('./network');

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const PLAYLIST_ID = /^(?:PL|UU|LL|FL|RD|OLAK5uy_)[a-zA-Z0-9_-]+$/;
let clientPromise;

// YouTube.js is used only for optional music metadata. Downloading, playlist
// enumeration, client selection, and challenge solving belong to yt-dlp.
function getClient() {
    if (!clientPromise) {
        clientPromise = (async () => {
            const { Innertube } = await import('youtubei.js');
            return Innertube.create({
                retrieve_player: false,
                retrieve_innertube_config: false,
                enable_session_cache: false,
                fetch: fetchWithTimeout
            });
        })().catch((error) => {
            clientPromise = undefined;
            throw error;
        });
    }
    return clientPromise;
}

function parseInput(input) {
    const value = typeof input === 'string' ? input.trim() : '';
    if (VIDEO_ID.test(value)) return { videoId: value };
    if (PLAYLIST_ID.test(value)) return { playlistId: value };

    let url;
    try {
        url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
        throw new Error('Enter a YouTube video or playlist link.');
    }

    const host = url.hostname.toLowerCase();
    const isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com');
    const isShortLink = host === 'youtu.be' || host === 'www.youtu.be';
    const isEmbed = host === 'youtube-nocookie.com' || host === 'www.youtube-nocookie.com';
    if (!['http:', 'https:'].includes(url.protocol) || (!isYouTube && !isShortLink && !isEmbed)) {
        throw new Error('Use a link from youtube.com or youtu.be.');
    }

    const playlistId = url.searchParams.get('list');
    // Preserve the original behavior: watch links containing a list download
    // the whole playlist, even when a video ID is also present.
    if (playlistId) {
        if (!/^[a-zA-Z0-9_-]+$/.test(playlistId)) throw new Error('This playlist link is invalid.');
        return { playlistId };
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const videoId = isShortLink ? segments[0]
        : ['shorts', 'embed', 'live', 'v'].includes(segments[0]) ? segments[1]
            : url.searchParams.get('v');
    if (!VIDEO_ID.test(videoId || '')) throw new Error('This link does not contain a valid YouTube video ID.');
    return { videoId };
}

module.exports = { getClient, parseInput };
