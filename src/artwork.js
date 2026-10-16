const axios = require('axios');

function thumbnailSize(image) {
    return Math.min(Number(image?.width) || 0, Number(image?.height) || 0);
}

function bestThumbnail(thumbnails = [], { square = false, minSize = 0 } = {}) {
    return (Array.isArray(thumbnails) ? thumbnails : [])
        .filter((image) => image?.url && thumbnailSize(image) >= minSize && (!square || (
            image.width > 0 && image.height > 0 && Math.abs(image.width / image.height - 1) < 0.1
        )))
        .sort((a, b) => thumbnailSize(b) - thumbnailSize(a) || (b.width || 0) - (a.width || 0))[0]?.url || '';
}

function bestCoverThumbnail(thumbnails, { allowSmall = false } = {}) {
    // A tiny square preview must not outrank larger release artwork. Require
    // at least 600 px on both sides before treating a cover as complete.
    return bestThumbnail(thumbnails, { square: true, minSize: 600 })
        || bestThumbnail(thumbnails, { minSize: 600 })
        || (allowSmall ? bestThumbnail(thumbnails) : '');
}

async function getCoverImage(url, signal) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        signal,
        timeout: 15000,
        maxContentLength: 10 * 1024 * 1024
    });
    return Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
}

module.exports = { bestCoverThumbnail, getCoverImage };
