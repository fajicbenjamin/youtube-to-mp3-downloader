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
    let title = `${info.videoDetails.media.artist} - ${info.videoDetails.media.song}`;

    let downloadPath = electron.app.getPath('downloads');

    // Given the url of the video, the path in which to store the output, and the video title
    // download the video as an audio only mp4 and write it to a temp file then return
    // the full path for the tmp file, the path in which its stored, and the title of the desired output.
    let paths = await getVideoAsMp4(url, downloadPath, title, event).catch(error => console.error(error));

    // Pass the returned paths and info into the function which will convert the mp4 tmp file into
    // the desired output mp3 file.
    await convertMp4ToMp3(paths, event);

    // Remove the temp mp4 file.
    fs.unlinkSync(paths.filePath);

    // write mp3 tags to file
    event.sender.send('download-status', 'Writing MP3 tags');
    await writeMp3TagsToFile(paths);

    event.sender.send('download-status', 'Done');
};

const getVideoAsMp4 = (urlLink, userProvidedPath, title, event) => {
    // Tell the user we are starting to get the video.
    event.sender.send('download-status', 'Downloading...');
    title = sanitize(title);

    return new Promise((resolve, reject) => {
        let fullPath = path.join(userProvidedPath, `tmp_${title}.mp4`);

        // Create a reference to the stream of the video being downloaded.
        let videoObject = ytdl(urlLink, {filter: 'audioonly'});

        videoObject.on('progress', (chunkLength, downloaded, total) => {
            // When the stream emits a progress event, we capture the currently downloaded amount and the total
            // to download, we then divided the downloaded by the total and multiply the result to get a float of
            // the percent complete, which is then passed through the Math.floor function to drop the decimals.
            // if (!this.rateLimitTriggered) {
                let newVal = Math.floor((downloaded / total) * 100);
                // this.setState({progress: newVal});

            event.sender.send('progress-status', newVal);

                // Set the rate limit trigger to true and set a timeout to set it back to false. This will prevent the UI
                // from updating every few milliseconds and creating visual lag.
                // this.rateLimitTriggered = true;
                // setTimeout(() => {
                //     this.rateLimitTriggered = false;
                // }, 800);
            // }
        });

        // Create write-able stream for the temp file and pipe the video stream into it.
        videoObject.pipe(fs.createWriteStream(fullPath)).on('finish', () => {
            // all of the video stream has finished piping, set the progress bar to 100% and give user pause to see the
            // completion of step. Then we return the path to the temp file, the output path, and the desired filename.
            // this.setState({progress: 100});
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

        console.log(paths.filePath)

        // Pass ffmpeg the temp mp4 file. Set the path where is ffmpeg binary for the platform. Provided desired format.
        ffmpeg(paths.filePath)
            .setFfmpegPath(binaries.ffmpegPath())
            .format('mp3')
            .audioBitrate(320)
            .on('progress', (progress) => {
                // Use same rate limiting as above in function "getVideoAsMp4()" to prevent UI lag.
                // if (!this.rateLimitTriggered) {
                event.sender.send('progress-status', Math.floor(progress.percent));
                //     this.rateLimitTriggered = true;
                //     setTimeout(() => {
                //         this.rateLimitTriggered = false;
                //     }, 800);
                // }
            })
            .output(fs.createWriteStream(path.join(paths.folderPath, sanitize(paths.fileTitle))))
            .on('end', () => {
                // After the mp3 is wrote to the disk we set the progress to 99% the last 1% is the removal of the temp file.
                // this.setState({progress: 99});
                resolve();
            })
            .run();
    });
};

const writeMp3TagsToFile = async (paths) => {
    let songName = paths.fileTitle.substr(0, paths.fileTitle.length - 4);

    let songData = await deezerApi.getSongData(songName);
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