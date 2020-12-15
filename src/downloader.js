const ffmpeg = require('fluent-ffmpeg');
const binaries = require('ffmpeg-binaries');
const sanitize = require('sanitize-filename');
const fs = require('fs');
const ytdl = require('ytdl-core');
const electron = require('electron');
const path = require('path');
const NodeID3 = require('node-id3');

const deezerApi = require('./deezerApi');

const startDownload = async (url, event) => {

    let info = await ytdl.getInfo(url);
    let title = '';

    if (info.videoDetails.media.song)
        title = `${info.videoDetails.media.artist} - ${info.videoDetails.media.song}`;
    else
        title = sanitize(escape(info.videoDetails.title.replace(/ *\([^)]*\) */g, "")));

    let songDataFromDeezer = await deezerApi.getSongData(title);

    if (songDataFromDeezer)
        title = `${songDataFromDeezer.artist} - ${songDataFromDeezer.title}`;
    else
        title = info.videoDetails.title; // use video title as file title

    let downloadPath = electron.app.getPath('downloads');

    // Given the url of the video, the path in which to store the output, and the video title
    // download the video as an audio only mp4 and write it to a temp file then return
    // the full path for the tmp file, the path in which its stored, and the title of the desired output.
    let paths = await getVideoAsMp4(url, downloadPath, title, event);

    // Pass the returned paths and info into the function which will convert the mp4 tmp file into
    // the desired output mp3 file.
    await convertMp4ToMp3(paths, event);

    // Remove the temp mp4 file.
    fs.unlinkSync(paths.filePath);

    // write mp3 tags to file
    if (songDataFromDeezer) {
        event.sender.send('download-status', 'Writing MP3 tags');
        await writeMp3TagsToFile(paths, songDataFromDeezer);
    }

    event.sender.send('download-status', 'Done');
};

const getVideoAsMp4 = (urlLink, userProvidedPath, title, event) => {
    // Tell the user we are starting to get the video.
    event.sender.send('download-status', 'Downloading...');

    return new Promise((resolve, reject) => {
        let fullPath = path.join(userProvidedPath, `tmp_${title}.mp4`);

        // Create a reference to the stream of the video being downloaded.
        let videoObject = ytdl(urlLink, {filter: 'audioonly'});

        videoObject.on('progress', (chunkLength, downloaded, total) => {
            let newVal = Math.floor((downloaded / total) * 100);
            event.sender.send('progress-status', newVal);
        });

        // Create write-able stream for the temp file and pipe the video stream into it.
        videoObject.pipe(fs.createWriteStream(fullPath)).on('finish', () => {
            setTimeout(() => {
                resolve({filePath: fullPath, folderPath: userProvidedPath, fileTitle: `${title}.mp3`});
            }, 1000);
        });
    });
};

const convertMp4ToMp3 = (paths, event) => {
    // Tell the user we are starting to convert the file to mp3.
    event.sender.send('download-status', 'Converting...');
    event.sender.send('progress-status', 0);

    return new Promise(async (resolve, reject) => {
        // Reset the rate limiting trigger just encase.
        this.rateLimitTriggered = false;

        // Pass ffmpeg the temp mp4 file. Set the path where is ffmpeg binary for the platform. Provided desired format.
        ffmpeg(paths.filePath)
            .setFfmpegPath(binaries.ffmpegPath())
            .format('mp3')
            .audioBitrate(320)
            .on('progress', (progress) => {
                event.sender.send('progress-status', Math.floor(progress.percent));
            })
            .output(fs.createWriteStream(path.join(paths.folderPath, sanitize(paths.fileTitle))))
            .on('end', () => {
                event.sender.send('progress-status', 100);
                resolve();
            })
            .run();
    });
};

const writeMp3TagsToFile = async (paths, songData) => {
    let coverImage = await deezerApi.getCoverImage(songData.cover);

    let image = {
        mime: "jpeg",
        type: {
            id: 3,
            name: "front cover"
        },
        description: "Song cover",
        imageBuffer: Buffer.from(coverImage.data)
    };

    const tags = {
        title: songData.title,
        artist: songData.artist.join(', '),
        album: songData.album,
        APIC: songData.cover,
        image: image
    };

    NodeID3.write(tags, path.join(paths.folderPath, sanitize(paths.fileTitle)));
};

module.exports = {
    startDownload
};