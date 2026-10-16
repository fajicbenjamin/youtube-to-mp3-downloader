const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const releases = require('../src/downloader-binaries.json');
const { installRuntime, verifyRuntime } = require('../src/downloader-runtime');

const root = path.resolve(__dirname, '..', 'vendor', 'downloader');

async function sha256(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function download(release, asset, destination) {
    const url = `https://github.com/${release.repository}/releases/download/${release.version}/${asset.name}`;
    console.log(`Downloading ${asset.name} (${release.version})`);
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
    const hash = createHash('sha256');
    await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(chunk, encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
        }
    }), fs.createWriteStream(destination, { flags: 'wx' }));
    if (hash.digest('hex') !== asset.sha256) throw new Error(`Checksum mismatch for ${asset.name}.`);
}

async function prepareDownloader(platform = process.platform, arch = process.arch) {
    const target = `${platform}-${arch}`;
    const ytAsset = releases.ytDlp.assets[target];
    if (!ytAsset) throw new Error(`No bundled download tools are configured for ${target}.`);
    const destination = path.join(root, target);
    const ytName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const revision = `${releases.ytDlp.version}:${ytAsset.sha256}`;
    const writeManifest = async (runtime = {}) => {
        if (platform !== 'win32') await fsp.chmod(path.join(destination, ytName), 0o755);
        await fsp.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({
            revision, target, ytDlp: releases.ytDlp.version, ...runtime
        }, null, 2));
        // Remove only the obsolete, known runtime files in this target folder.
        for (const name of ['deno', 'deno.exe', ...(ytAsset.layout === 'directory' ? ['yt-dlp.exe'] : [])]) {
            await fsp.rm(path.join(destination, name), { force: true }).catch((error) => {
                // Packaging has an explicit file list, so an old process holding
                // this obsolete binary open must not block the new app's setup.
                console.warn(`Could not remove unused ${name}: ${error.message}`);
            });
        }
    };

    let reusable;
    try {
        const installed = JSON.parse(await fsp.readFile(path.join(destination, 'manifest.json'), 'utf8'));
        if (installed.target === target && installed.ytDlp === releases.ytDlp.version) {
            if (ytAsset.layout === 'directory' && installed.layout === 'directory' && installed.revision === revision) {
                await verifyRuntime(destination, { ...ytAsset, manifestSha256: installed.manifestSha256 });
                reusable = { layout: 'directory', executable: ytAsset.executable, sha256: ytAsset.sha256,
                    manifestSha256: installed.manifestSha256 };
            } else if (!ytAsset.layout && await sha256(path.join(destination, ytName)) === ytAsset.sha256) {
                reusable = {};
            }
        }
    } catch { /* Missing or changed tools are replaced with verified release assets. */ }
    if (reusable) {
        await writeManifest(reusable);
        return;
    }

    await fsp.mkdir(root, { recursive: true });
    const temporary = await fsp.mkdtemp(path.join(root, '.prepare-'));
    try {
        const assetFile = path.join(temporary, ytAsset.name);
        await download(releases.ytDlp, ytAsset, assetFile);
        let runtime = {};
        if (ytAsset.layout === 'directory') {
            const manifestSha256 = await installRuntime(assetFile, temporary, ytAsset.executable, ytAsset.sha256);
            runtime = { layout: 'directory', executable: ytAsset.executable, sha256: ytAsset.sha256, manifestSha256 };
        }
        await fsp.mkdir(destination, { recursive: true });
        // Do not leave a valid manifest pointing to a partially replaced tool.
        await fsp.rm(path.join(destination, 'manifest.json'), { force: true });
        if (ytAsset.layout === 'directory') {
            // Both paths are fixed children of this target's vendor directory.
            await fsp.rm(path.join(destination, 'runtime'), { recursive: true, force: true });
            await fsp.rename(path.join(temporary, 'runtime'), path.join(destination, 'runtime'));
            await fsp.copyFile(path.join(temporary, 'runtime-manifest.json'), path.join(destination, 'runtime-manifest.json'));
        } else {
            await fsp.copyFile(assetFile, path.join(destination, ytName));
        }
        await writeManifest(runtime);
        console.log(`Download tools ready for ${target}.`);
    } finally {
        // This directory was created above under this repository's vendor root.
        await fsp.rm(temporary, { recursive: true, force: true });
    }
}

if (require.main === module) {
    prepareDownloader(process.argv[2] || process.platform, process.argv[3] || process.arch).catch((error) => {
        console.error(`Could not prepare download tools: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { prepareDownloader };
