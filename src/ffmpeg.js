const fsp = require('node:fs/promises');
const readline = require('node:readline');
const { spawnTool, stopChild } = require('./tool-processes');

const ffmpegPath = require('ffmpeg-static')?.replace('app.asar', 'app.asar.unpacked');

async function convertToMp3(audioPath, mp3Path, duration, send, signal) {
    signal?.throwIfAborted();
    if (!ffmpegPath) throw new Error('FFmpeg is not available for this platform.');
    send('download-status', 'Converting to MP3');
    send('download-progress', 50);
    await new Promise((resolve, reject) => {
        // Arguments are passed directly, so spaces and Unicode in paths do not
        // need shell quoting. The output belongs to this download's temp folder.
        const child = spawnTool(ffmpegPath, [
            '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error',
            '-progress', 'pipe:1', '-stats_period', '0.5',
            '-i', audioPath, '-map', '0:a:0', '-vn', '-sn', '-dn',
            // LAME V2 selects the bitrate per frame to maintain high quality.
            '-c:a', 'libmp3lame', '-q:a', '2',
            // Song tags and artwork are written separately after conversion.
            '-map_metadata', '-1', '-map_chapters', '-1', '-id3v2_version', '3', '-f', 'mp3', '-n', mp3Path
        ]);
        let failure;
        let stderr = '';
        let lastProgress = 50;
        let timer;
        const fail = (error) => {
            if (failure) return;
            failure = error;
            stopChild(child);
        };
        const abort = () => fail(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        const armTimeout = () => {
            clearTimeout(timer);
            timer = setTimeout(() => fail(new Error('FFmpeg stopped responding for two minutes. Please try again.')), 120000);
            timer.unref();
        };
        armTimeout();

        const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        output.on('line', (line) => {
            if (failure) return;
            armTimeout();
            // FFmpeg reports out_time_us in microseconds. Avoid scraping the
            // human-readable stderr status line or the misleading out_time_ms.
            if (!line.startsWith('out_time_us=')) return;
            const elapsed = Number(line.slice('out_time_us='.length)) / 1000000;
            if (!Number.isFinite(elapsed) || !Number.isFinite(duration) || duration <= 0) return;
            const progress = Math.min(98, Math.max(lastProgress, Math.floor(50 + elapsed / duration * 48)));
            if (progress === lastProgress) return;
            lastProgress = progress;
            try { send('download-progress', progress); }
            catch (error) { fail(error); }
        });
        output.on('error', fail);
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            if (failure) return;
            armTimeout();
            stderr = (stderr + chunk).slice(-8192);
        });
        child.stderr.on('error', fail);
        child.on('error', (error) => {
            const launchError = new Error(`Could not start FFmpeg: ${error.message}`);
            launchError.code = 'DOWNLOAD_TOOLS_MISSING';
            fail(launchError);
        });
        child.on('close', (code, exitSignal) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            output.close();
            if (!failure && code !== 0) {
                const detail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
                failure = new Error(`MP3 conversion failed: ${detail || exitSignal || `FFmpeg exited with code ${code}`}`);
                // Stop a playlist on local storage failures instead of trying
                // to convert every remaining track into the same broken folder.
                if (/No space left|disk.{0,20}full/i.test(stderr)) failure.code = 'ENOSPC';
                else if (/Permission denied|Access is denied/i.test(stderr)) failure.code = 'EACCES';
                else if (/Read-only file system/i.test(stderr)) failure.code = 'EROFS';
                else if (/Disk quota exceeded/i.test(stderr)) failure.code = 'EDQUOT';
            }
            // Wait for process exit and closed streams before tagging or
            // deleting temporary files, including when conversion is stopped.
            if (failure) reject(failure);
            else resolve();
        });
    });

    const output = await fsp.stat(mp3Path);
    if (!output.isFile() || !output.size) throw new Error('FFmpeg did not produce an MP3 file.');
    send('download-progress', 98);
}

module.exports = { ffmpegPath, convertToMp3 };
