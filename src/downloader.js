const ffmpeg = require('fluent-ffmpeg');
const binaries = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const fs = require('fs');
const ytdl = require('ytdl-core');
const electron = require('electron');
const path = require('path');
const ID3Writer = require('browser-id3-writer');
const ytpl = require('ytpl');

const deezerApi = require('./deezer-api');

const LOWER_BITRATE = 128;
const HIGHER_BITRATE = 320;

const startDownload = async (params, event) => {

    let playlist;

    // fetch to see if playlist and download each song, otherwise just do single download
    playlist = await ytpl(params.url, { pages: 1 }).catch(error => console.log(error))

    if (playlist && playlist.items.length) {

        const playlistSize = playlist.estimatedItemCount;
        let c = 0;

        while (true) {
            for (let i = 0; i < playlist.items.length; i++) {
                event.sender.send('playlist-status', `Playlist ${++c} / ${playlistSize}`)
                let song = playlist.items[i];
                await singleDownload({url: song.url}, event, playlist.title || "playlistOutput");
            }

            if (!playlist.continuation)
                break;

            playlist = await ytpl.continueReq(playlist.continuation);
        }

        event.sender.send('playlist-status', 'Playlist complete');

    } else {

        await singleDownload(params, event);
    }
}

const singleDownload = async (params, event, playlistTitle = "") => {

    const info = await ytdl.getInfo(params.url).catch(error => console.log(error));

    if (!info) {
        event.sender.send('download-status', 'Video not found');
        return;
    }

    let lengthSeconds = info.videoDetails.lengthSeconds;

    // trim title and try it against Deezer API if manual search is not given
    let title = info.videoDetails.title
        .replace(/ *\([^)]*\) */g, " ") // remove parenthesis and what is inside
        .replace(/[^A-Za-z0-9 ]/g, "") // remove special characters
        .replace(/feat|feat.|ft.|[0-9]k|hd/ig, "") // remove "feat" or stuff like "2K" "4K" etc.
        .replace(/(?<=^| ).(?=$| )/g, ""); // remove single character words

    let songDataFromDeezer;

    songDataFromDeezer = await deezerApi.getSongData(params.coverSearch ? params.coverSearchTitle : title);

    if (songDataFromDeezer) {
        title = `${songDataFromDeezer.artist.join(', ')} - ${songDataFromDeezer.title}`;

        event.sender.send('show-data', songDataFromDeezer);
    } else {
        // use video title as file title
        title = info.videoDetails.title
            .replace(/[^A-Za-z0-9 ]/g, ""); // replace special characters, since this will be saved to file system
    }

    let downloadPath = electron.app.getPath('downloads');

    // If there is a playlist we make a new folder for it in the downloads folder with the playlist title.
    if (playlistTitle) {
        downloadPath += "/" + playlistTitle;
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, {recursive: true});
        }
    }

    // Given the url of the video, the path in which to store the output, and the video title
    // download the video as an audio only mp4 and write it to a temp file then return
    // the full path for the tmp file, the path in which its stored, and the title of the desired output.
    let paths = await getVideoAsMp4(params.url, downloadPath, title, event);
    const bitRate = params.lowerBitrate ? LOWER_BITRATE : HIGHER_BITRATE;

    // Pass the returned paths and info into the function which will convert the mp4 tmp file into
    // the desired output mp3 file.
    await convertMp4ToMp3(paths, event, lengthSeconds, bitRate);

    // Remove the temp mp4 file.
    fs.unlinkSync(paths.filePath);

    // write mp3 tags to file
    if (songDataFromDeezer) {
        event.sender.send('download-status', 'Writing MP3 tags');
        await writeMp3TagsToFile(paths, songDataFromDeezer);
    }

    event.sender.send('download-status', 'Done', title);
};

const getVideoAsMp4 = (urlLink, userProvidedPath, title, event) => {
    // Tell the user we are starting to get the video.
    event.sender.send('download-status', 'Downloading');

    return new Promise((resolve, reject) => {
        let fullPath = path.join(userProvidedPath, `tmp_${title}.mp4`);

        // Create a reference to the stream of the video being downloaded.
        let videoObject = ytdl(urlLink, {filter: 'audioonly'});

        videoObject.on('progress', (chunkLength, downloaded, total) => {
            let newVal = Math.floor((downloaded / total) * 100 / 2);
            // event.sender.send('progress-status', newVal);
            event.sender.send('download-status', `Downloading`)
            event.sender.send('download-progress', newVal);
        });

        // Create write-able stream for the temp file and pipe the video stream into it.
        videoObject.pipe(fs.createWriteStream(fullPath)).on('finish', () => {
            setTimeout(() => {
                resolve({filePath: fullPath, folderPath: userProvidedPath, fileTitle: `${title}.mp3`});
            }, 1000);
        });
    });
};

const convertMp4ToMp3 = (paths, event, videoLength, bitRate) => {
    // Tell the user we are starting to convert the file to mp3.
    event.sender.send('download-status', 'Converting');
    // event.sender.send('progress-status', 0);

    return new Promise(async (resolve, reject) => {

        // Pass ffmpeg the temp mp4 file. Set the path where is ffmpeg binary for the platform. Provided desired format.
        ffmpeg(paths.filePath)
            .setFfmpegPath(binaries)
            .format('mp3')
            .audioBitrate(bitRate)
            .on('progress', (progress) => {
                let times = progress.timemark.split(':');
                let seconds = +times[2];
                seconds += (+times[1] * 60);
                seconds += (+times[0] * 360);

                let newVal = Math.floor((seconds / videoLength) * 100 / 2 + 50);
                event.sender.send('download-status', `Converting`);
                event.sender.send('download-progress', newVal);
            })
            .output(fs.createWriteStream(path.join(paths.folderPath, paths.fileTitle)))
            .on('end', () => {
                // event.sender.send('progress-status', 100);
                event.sender.send('download-progress', 0);
                resolve();
            })
            .run();
    });
};

const writeMp3TagsToFile = async (paths, songData) => {

    let coverImage = await deezerApi.getCoverImage(songData.cover);

    const songBuffer = fs.readFileSync(path.join(paths.folderPath, paths.fileTitle));

    const writer = new ID3Writer(songBuffer);
    writer.setFrame('TIT2', songData.title)
        .setFrame('TPE1', songData.artist)
        .setFrame('TALB', songData.album)
        .setFrame('APIC', {
            type: 3,
            data: Buffer.from(coverImage.data, 'base64'),
            description: 'Front cover'
        });
    writer.addTag();

    fs.unlinkSync(path.join(paths.folderPath, paths.fileTitle));

    const taggedSongBuffer = Buffer.from(writer.arrayBuffer);
    fs.writeFileSync(path.join(paths.folderPath, paths.fileTitle), taggedSongBuffer);
};

module.exports = {
    startDownload
};
