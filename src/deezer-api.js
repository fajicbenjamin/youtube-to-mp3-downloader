const axios = require('axios');
const baseUrl = 'https://api.deezer.com';

const getSongData = async (songName, signal) => {
    let response = await axios.get(`${baseUrl}/search`, { params: { q: songName }, timeout: 15000, signal });

    if (response.data.error) throw new Error(response.data.error.message || 'Deezer search is unavailable.');

    if (!response.data.total || !response.data.data?.length) {
        return null
    }

    let songData = response.data.data[0];
    let artist = await getTrackContributors(songData.id, signal).catch(() => {
        signal?.throwIfAborted();
        return [];
    });
    if (!artist.length) artist = [songData.artist?.name].filter(Boolean);
    if (!songData.title || !artist.length) return null;

    return {
        artist: artist,
        title: songData.title,
        album: songData.album?.title || '',
        cover: songData.album?.cover_big || ''
    };
};

const getTrackContributors = async (trackId, signal) => {
    let response = await axios.get(`${baseUrl}/track/${trackId}`, { timeout: 15000, signal });

    const artists = [];
    (response.data.contributors || []).forEach(contributor => {
        if (contributor.name) artists.push(contributor.name);
    });

    return artists;
};

module.exports = {
    getSongData
};
