const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const HASH = /^[a-f0-9]{64}$/;
const MAX_FILES = 4096;
const MAX_BYTES = 512 * 1024 * 1024;
const verifiedFiles = new Map();

function safeRelativePath(name) {
    return typeof name === 'string' && name.length > 0 && name.length < 512 &&
        !/[\\:\x00-\x1f<>"|?*]/.test(name) && name.split('/').every((part) =>
            part && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

async function fileHash(file, signal) {
    signal?.throwIfAborted();
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
    return hash.digest('hex');
}

async function verifyFile(file, expected, signal) {
    signal?.throwIfAborted();
    const info = await fsp.lstat(file);
    if (!info.isFile() || info.size !== expected.size) throw new Error('An engine support file is missing or changed.');
    const signature = `${expected.sha256}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (verifiedFiles.get(file) !== signature) {
        if (await fileHash(file, signal) !== expected.sha256) throw new Error('Engine support file checksum mismatch.');
        verifiedFiles.set(file, signature);
    }
}

async function runtimeFiles(directory, prefix = '') {
    const files = [];
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (!safeRelativePath(relative)) throw new Error('Invalid engine support-file path.');
        if (entry.isDirectory()) files.push(...await runtimeFiles(path.join(directory, entry.name), `${relative}/`));
        else if (entry.isFile()) files.push(relative);
        else throw new Error('Engine packages must not contain links or special files.');
        if (files.length > MAX_FILES) throw new Error('The engine package contains too many files.');
    }
    return files.sort();
}

async function installRuntime(archive, folder, executable, archiveSha256, signal) {
    signal?.throwIfAborted();
    if (!safeRelativePath(executable) || executable.includes('/') || !HASH.test(archiveSha256)) {
        throw new Error('Invalid engine package description.');
    }
    // Load ZIP handling only during setup/update, never before a download.
    const { openPromise } = require('yauzl');
    const directory = path.join(folder, 'runtime');
    // Require a fresh destination so existing links cannot redirect extraction.
    await fsp.mkdir(directory);
    const zip = await openPromise(archive, { strictFileNames: true, validateEntrySizes: true });
    let bytes = 0;
    let count = 0;
    const names = new Set();
    try {
        for await (const entry of zip.eachEntry()) {
            signal?.throwIfAborted();
            const name = entry.fileName.replace(/\/$/, '');
            const type = (entry.externalFileAttributes >>> 16) & 0o170000;
            const isDirectory = entry.fileName.endsWith('/') || type === 0o040000 ||
                Boolean(entry.externalFileAttributes & 0x10);
            bytes += entry.uncompressedSize;
            count++;
            if (!safeRelativePath(name) || (type && type !== 0o100000 && type !== 0o040000) ||
                (type === 0o100000 && isDirectory) || entry.isEncrypted() ||
                !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
                (isDirectory && entry.uncompressedSize !== 0) ||
                names.has(name.toLowerCase()) || count > MAX_FILES || bytes > MAX_BYTES) {
                throw new Error('Invalid or oversized engine archive.');
            }
            names.add(name.toLowerCase());
            // Validate before creating any paths; never create archive symlinks.
            const destination = path.join(directory, name);
            if (isDirectory) {
                await fsp.mkdir(destination, { recursive: true });
            } else {
                await fsp.mkdir(path.dirname(destination), { recursive: true });
                const source = await zip.openReadStreamPromise(entry);
                await pipeline(source, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
            }
        }
    } finally {
        zip.close();
    }
    const files = [];
    for (const relative of await runtimeFiles(directory)) {
        signal?.throwIfAborted();
        const file = path.join(directory, relative);
        const info = await fsp.stat(file);
        files.push({ path: relative, size: info.size, sha256: await fileHash(file, signal) });
    }
    if (!files.some((file) => file.path === executable && file.size > 0) ||
        !files.some((file) => file.path !== executable && /\.dll$/i.test(file.path))) {
        throw new Error('The Windows engine package is missing its executable or Python support files.');
    }
    const manifestFile = path.join(folder, 'runtime-manifest.json');
    await fsp.writeFile(manifestFile, JSON.stringify({ version: 1, archiveSha256, executable, files }));
    return fileHash(manifestFile, signal);
}

async function verifyRuntime(folder, { executable, sha256, manifestSha256 }, signal) {
    if (!safeRelativePath(executable) || executable.includes('/') || !HASH.test(sha256) || !HASH.test(manifestSha256)) {
        throw new Error('Invalid engine runtime manifest.');
    }
    const manifestFile = path.join(folder, 'runtime-manifest.json');
    const info = await fsp.lstat(manifestFile);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Invalid engine runtime manifest.');
    await verifyFile(manifestFile, { size: info.size, sha256: manifestSha256 }, signal);
    const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
    if (manifest.version !== 1 || manifest.archiveSha256 !== sha256 || manifest.executable !== executable ||
        !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) {
        throw new Error('Engine runtime manifest does not match this release.');
    }
    const directory = path.join(folder, 'runtime');
    if (!(await fsp.lstat(directory)).isDirectory()) throw new Error('Invalid engine runtime directory.');
    const actualFiles = await runtimeFiles(directory);
    const expectedFiles = manifest.files.map((file) => file.path).sort();
    if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index]) ||
        !expectedFiles.includes(executable)) throw new Error('Engine runtime files are missing or changed.');
    for (const file of manifest.files) {
        if (!safeRelativePath(file.path) || !HASH.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) {
            throw new Error('Invalid engine support-file entry.');
        }
    }
    // Bound simultaneous reads, but avoid one filesystem round trip at a time
    // for every DLL on each launch. Unchanged files reuse their verified hash.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, manifest.files.length) }, async () => {
        while (next < manifest.files.length) {
            const file = manifest.files[next++];
            await verifyFile(path.join(directory, file.path), file, signal);
        }
    }));
    return path.join(directory, executable);
}

module.exports = { installRuntime, verifyRuntime };
