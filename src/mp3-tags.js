const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const ID3Writer = require('browser-id3-writer');

async function audioOffset(file) {
    const handle = await fsp.open(file, 'r');
    try {
        const header = Buffer.alloc(10);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (header.toString('ascii', 0, 3) !== 'ID3') return 0;
        if (bytesRead !== 10 || ![2, 3, 4].includes(header[3]) || header.subarray(6).some((byte) => byte & 0x80)) {
            throw new Error('The MP3 has an invalid ID3 header.');
        }
        // ID3v2 stores the tag length in four 7-bit bytes, excluding the header.
        const size = header.subarray(6).reduce((total, byte) => total * 128 + byte, 0);
        const footer = header[3] === 4 && (header[5] & 0x10) ? 10 : 0;
        const offset = 10 + size + footer;
        if (offset >= (await handle.stat()).size) throw new Error('The MP3 has no audio after its ID3 tag.');
        return offset;
    } finally {
        await handle.close();
    }
}

async function writeMp3Tags(mp3Path, songData, cover, signal) {
    signal?.throwIfAborted();
    // Build only the small tag in memory. The recording itself stays on disk.
    const writer = new ID3Writer(new ArrayBuffer(0));
    writer.padding = 0;
    writer.setFrame('TIT2', songData.title);
    if (songData.artist.length) writer.setFrame('TPE1', songData.artist);
    if (songData.album) writer.setFrame('TALB', songData.album);
    if (cover) {
        try { writer.setFrame('APIC', { type: 3, data: cover, description: 'Front cover' }); }
        catch (error) { console.warn(`${songData.title}: could not embed artwork. ${error.message}`); }
    }
    writer.addTag();
    const tag = Buffer.from(writer.arrayBuffer);
    const offset = await audioOffset(mp3Path);
    const taggedPath = `${mp3Path}.tagged`;
    async function* contents() {
        yield tag;
        yield* fs.createReadStream(mp3Path, { start: offset, highWaterMark: 256 * 1024 });
    }
    try {
        await pipeline(contents(), fs.createWriteStream(taggedPath, { flags: 'wx' }), { signal });
        signal?.throwIfAborted();
        // Keep the original playable output until the complete tagged file is ready.
        await fsp.rename(taggedPath, mp3Path);
    } finally {
        await fsp.rm(taggedPath, { force: true }).catch(() => {});
    }
}

async function saveWithoutOverwrite(mp3Path, folder, title, signal) {
    const noHardLinks = new Set(['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'EMLINK']);
    let useCopy = false;
    for (let suffix = 0; ; suffix++) {
        signal?.throwIfAborted();
        const output = path.join(folder, `${title}${suffix ? ` (${suffix})` : ''}.mp3`);
        try {
            if (!useCopy) {
                try {
                    // Staging is on the destination volume. A hard link publishes
                    // the finished bytes atomically without another full copy.
                    await fsp.link(mp3Path, output);
                    return output;
                } catch (error) {
                    if (!noHardLinks.has(error.code)) throw error;
                    useCopy = true;
                }
            }
            // FAT/exFAT and some network volumes do not support hard links.
            await fsp.copyFile(mp3Path, output, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
            return output;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }
}

module.exports = { writeMp3Tags, saveWithoutOverwrite };
