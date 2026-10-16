function text(value) {
    const content = typeof value === 'string' ? value : value?.text;
    return typeof content === 'string' ? content.trim() : '';
}

function normalize(value) {
    return text(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/[’']/g, '').replace(/đ/g, 'dj')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function isPresentationLabel(value) {
    return /^(?:(?:official|music|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|8k|1080p|720p)\s*)+$/.test(normalize(value));
}

function cleanTitle(value) {
    return text(value)
        // Remove packaging labels only; retain remix names, live venues, years,
        // and every other qualifier inside parentheses or brackets.
        .replace(/\(([^()]*)\)|\[([^\[\]]*)\]/g, (whole, round, square) =>
            isPresentationLabel(round || square) ? ' ' : whole)
        .replace(/\s+[-–—|]\s+([^|–—-]+)$/, (whole, suffix) => isPresentationLabel(suffix) ? '' : whole)
        .replace(/\s+(?:official\s+(?:(?:music|lyric|lyrics)\s+)?(?:video|audio)|lyrics?\s+video)(?:\s+(?:hd|hq|4k|8k))?$/i, '')
        .replace(/\s+/g, ' ').trim().replace(/\s+[-–—|]$/, '').trim();
}

function artistKey(artists) {
    // Compare all credited names, allowing collaboration order and punctuation
    // to differ. Never reduce this to a match on just one common artist/token.
    return normalize(artists.map(text).join(' ')).replace(/\b(?:feat|featuring|ft|x)\b/g, ' ')
        .split(/\s+/).filter(Boolean).sort().join(' ');
}

function includesCredits(artists, featured) {
    const remaining = artistKey(artists).split(' ');
    return artistKey([featured]).split(' ').every((word) => {
        const index = remaining.indexOf(word);
        if (index < 0) return false;
        remaining.splice(index, 1);
        return true;
    });
}

function songIdentity(title, artists) {
    let song = cleanTitle(title);
    const credits = artists.map(text).filter(Boolean);
    // A featured artist can appear in the song title or in the artist column.
    const featured = /\s*(?:[\[(]\s*)?\b(?:feat(?:uring)?|ft)\.?\s+(.+?)(?:\s*[\])])?$/i.exec(song);
    if (featured) {
        song = song.slice(0, featured.index).trim();
        // Search results often already include the featured artist in credits.
        if (!includesCredits(credits, featured[1])) credits.push(featured[1]);
    }
    return { title: normalize(song), artists: artistKey(credits) };
}

const versionRules = [
    ['live', /\blive\b/], ['remix', /\bremix(?:ed)?\b/],
    ['acoustic', /\bacoustic\b/], ['instrumental', /\binstrumental\b/],
    ['karaoke', /\bkaraoke\b/], ['cover', /\bcover\b/],
    ['remaster', /\bremaster(?:ed)?\b/], ['sped up', /\b(?:sped|speed) up\b/],
    ['slowed', /\bslowed\b/], ['nightcore', /\bnightcore\b/],
    ['radio edit', /\bradio (?:edit|version|mix)\b/], ['extended', /\bextended\b/],
    ['demo', /\bdemo\b/], ['unplugged', /\bunplugged\b/],
    ['clean', /\bclean\b/], ['explicit', /\bexplicit\b/],
    ['re-recorded', /\b(?:re recorded|rerecorded|re recording|rerecording)\b/],
    ['mono', /\bmono\b/], ['stereo', /\bstereo\b/]
];

function versions(value) {
    const normalized = normalize(value);
    return versionRules.filter(([, pattern]) => pattern.test(normalized)).map(([name]) => name).join('|');
}

function musicReference(details) {
    const duration = Number(details?.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const videoTitle = cleanTitle(details.title);
    const parts = videoTitle.split(/\s+[-–—|]\s+|[–—]/).map((part) => part.trim());
    let title = cleanTitle(details.track);
    let artists = (Array.isArray(details.artists) ? details.artists : []).map(text).filter(Boolean);
    if (!artists.length && text(details.artist)) artists = [text(details.artist)];
    if (!title || !artists.length) {
        // A channel/uploader might be a label, fan, or unrelated account. Only
        // use explicit song fields or a title that supplies both artist and song.
        if (parts.length < 2 || !parts[0]) return null;
        artists = [parts[0]];
        title = parts.slice(1).join(' - ');
    } else if (parts.length >= 2 && artistKey([parts[0]]) === artistKey(artists)) {
        // The video title may retain a version name omitted by track metadata.
        title = parts.slice(1).join(' - ');
    } else if (normalize(videoTitle) !== normalize(title)) {
        // Do not use background-song credits to identify an unrelated video.
        return null;
    }
    const identity = songIdentity(title, artists);
    if (!identity.title || !identity.artists) return null;
    return {
        ...identity, duration, album: normalize(details.album),
        query: `${artists.join(' ')} ${title}`.slice(0, 300),
        versions: versions(`${artists.join(' ')} ${title} ${text(details.album)}`)
    };
}

function selectMusicMatch(reference, tracks) {
    // Small video intros/outros are allowed, but not a substantially different
    // edit: 3% of the source duration, bounded between 3 and 10 seconds.
    const tolerance = Math.min(10, Math.max(3, reference.duration * 0.03));
    const matches = new Map();
    for (const track of tracks) {
        if (track?.item_type !== 'song' || !/^[\w-]{11}$/.test(track.id || '')) continue;
        const duration = Number(track.duration?.seconds);
        if (!Number.isFinite(duration) || duration <= 0 || Math.abs(duration - reference.duration) > tolerance) continue;
        const artists = (track.artists || []).filter((artist) => artist.channel_id?.startsWith('UC'))
            .map((artist) => text(artist.name)).filter(Boolean);
        if (!artists.length) continue;
        const identity = songIdentity(track.title, artists);
        if (identity.title !== reference.title || identity.artists !== reference.artists) continue;
        const album = text(track.album?.name);
        if (versions(`${artists.join(' ')} ${text(track.title)} ${album}`) !== reference.versions) continue;
        matches.set(track.id, track);
    }
    let candidates = [...matches.values()];
    if (reference.album) {
        const sameAlbum = candidates.filter((track) => normalize(track.album?.name) === reference.album);
        if (sameAlbum.length) candidates = sameAlbum;
    }
    if (!candidates.length) {
        return { reason: 'YouTube Music search found no song matching the title, artists, duration, and version.' };
    }

    // Repeated entries for the same release are harmless, but do not guess
    // between different albums, editions, or clean/explicit recordings.
    const releases = new Set(candidates.map((track) => JSON.stringify([
        normalize(track.title), artistKey(track.artists.map((artist) => text(artist.name))),
        track.album?.id || normalize(track.album?.name) || track.id,
        Number(track.duration.seconds),
        (track.badges || []).some((badge) => badge.icon_type === 'MUSIC_EXPLICIT_BADGE')
    ])));
    if (releases.size > 1) {
        return { reason: 'Several YouTube Music releases matched; no version was selected automatically.' };
    }
    return { track: candidates[0] };
}

module.exports = { musicReference, selectMusicMatch };
