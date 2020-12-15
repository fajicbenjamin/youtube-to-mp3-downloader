const axios = require('axios');
const baseUrl = 'https://api.deezer.com';

const getSongData = async (songName) => {
    let response = await axios.get(`${baseUrl}/search?q=${songName}`);

    if (!response.data.total) {
        return null
    }

    let songData = response.data.data[0];
    let artist = await getTrackContributors(songData.id);

    return {
        artist: artist,
        title: songData.title,
        album: songData.album.title,
        cover: songData.album.cover_big
    };
};

const getTrackContributors = async (trackId) => {
    let response = await axios.get(`${baseUrl}/track/${trackId}`);

    const artists = [];
    response.data.contributors.forEach(contributor => artists.push(contributor.name));

    return artists;
};

const getCoverImage = (coverUrl) => {
    return axios.get(coverUrl, {
        responseType: 'arraybuffer'
    });
};

module.exports = {
    getSongData,
    getCoverImage
};