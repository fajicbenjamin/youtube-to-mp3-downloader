const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const licenseRoot = path.join(root, 'licenses');
const read = (file) => fs.readFile(file, 'utf8');
const json = async (file) => JSON.parse(await read(file));
const text = async (name, file) => ({ name, text: await read(file) });
const legalName = /^(licen[cs]es?|copying|notice|copyright|third[-_]party[-_](?:licenses?|notices?))([.\-_]|$)/i;
const normalize = (value) => value.replace(/\r\n/g, '\n').trim();

async function packageTexts(directory) {
    const files = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const name = entry.name;
        if (entry.isFile() && legalName.test(entry.name)) files.push(await text(name, path.join(directory, name)));
        // Packages sometimes keep additional licenses in a licenses/ directory.
        if (entry.isDirectory() && /^(licenses?|notices?)$/i.test(entry.name)) {
            for (const item of await fs.readdir(path.join(directory, name), { withFileTypes: true })) {
                if (item.isFile()) files.push(await text(`${name}/${item.name}`, path.join(directory, name, item.name)));
            }
        }
    }
    return files;
}

async function prepareLicenses(platform = process.platform, arch = process.arch) {
    // ffmpeg-static installs one platform binary; don't label a host binary as a different target.
    if (platform !== process.platform || arch !== process.arch) {
        throw new Error('Package on the target OS and architecture so FFmpeg and its license/source records match.');
    }
    const [lock, manifest, releases] = await Promise.all([
        json(path.join(root, 'package-lock.json')), json(path.join(licenseRoot, 'manifest.json')),
        json(path.join(root, 'src/downloader-binaries.json'))
    ]);
    if (manifest.ytDlpVersion !== releases.ytDlp.version) {
        throw new Error('Refresh licenses/yt-dlp-* and licenses/manifest.json for the bundled yt-dlp release.');
    }
    const supplements = new Map();
    const add = (component, contents) => {
        const key = normalize(contents);
        if (!key) throw new Error(`Empty license text for ${component}.`);
        if (!supplements.has(key)) supplements.set(key, { components: new Set(), text: contents });
        supplements.get(key).components.add(component);
    };
    const yt = releases.ytDlp;
    const ytBase = `https://github.com/${yt.repository}`;
    const target = `${platform}-${arch}`;
    const ytLabel = `yt-dlp ${yt.version}\nSource and build scripts: ${ytBase}/tree/${yt.version}\nProject source archive: ${ytBase}/releases/download/${yt.version}/yt-dlp.tar.gz`;
    add(ytLabel, await read(path.join(licenseRoot, 'yt-dlp-Unlicense.txt')));
    // The Windows directory distribution already ships these notices. Single-file
    // macOS/Linux distributions need the separate upstream notice snapshot.
    const runtimeNotices = path.join(root, 'vendor/downloader', target, 'runtime/_internal/THIRD_PARTY_LICENSES.txt');
    const bundledNotices = yt.assets[target]?.layout === 'directory'
        ? await read(runtimeNotices).catch((error) => { if (error.code !== 'ENOENT') throw error; return ''; }) : '';
    if (!bundledNotices.trim()) {
        add(ytLabel, await read(path.join(licenseRoot, 'yt-dlp-THIRD_PARTY_LICENSES.txt')));
    }

    for (const [location, entry] of Object.entries(lock.packages)) {
        if (!location || entry.dev) continue;
        const directory = path.resolve(root, location);
        if (!directory.startsWith(path.join(root, 'node_modules') + path.sep)) throw new Error('Invalid package path in lockfile.');
        let pkg;
        try { pkg = await json(path.join(directory, 'package.json')); }
        catch (error) {
            if (entry.optional && error.code === 'ENOENT') continue;
            throw error;
        }
        if (pkg.version !== entry.version) throw new Error(`Run npm ci: ${pkg.name} does not match the lockfile.`);
        // electron-builder preserves existing LICENSE/NOTICE files in node_modules.
        // Only supplement omissions; do not assemble another copy of every license.
        const included = await packageTexts(directory);
        const component = `${pkg.name} ${pkg.version}`;
        let supplied = included.some((file) => file.text.trim());
        const override = manifest.overrides[`${pkg.name}@${pkg.version}`];
        for (const name of override || []) {
            const contents = await read(path.join(licenseRoot, name));
            if (!normalize(contents)) throw new Error(`Empty license text: ${name}.`);
            if (!included.some((file) => normalize(file.text).includes(normalize(contents)))) add(component, contents);
            supplied = true;
        }
        if (!supplied) {
            // These READMEs are excluded by electron-builder. Keep just their
            // complete MIT notice, including the original copyright attribution.
            const readme = (await fs.readdir(directory)).find((name) => /^readme(?:\.|$)/i.test(name));
            if (readme) {
                const contents = await read(path.join(directory, readme));
                const notice = contents.match(/^Copyright[^\r\n]*\r?\n\s*\r?\nPermission is hereby granted[\s\S]*?SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\s+SOFTWARE\./im)?.[0];
                if (notice) {
                    add(component, notice);
                    supplied = true;
                }
            }
        }
        if (!supplied) throw new Error(`Missing license text for ${pkg.name}@${pkg.version}; add a reviewed licenses/manifest.json override.`);
    }

    const ffmpegDir = path.join(root, 'node_modules/ffmpeg-static');
    const ffmpeg = await json(path.join(ffmpegDir, 'package.json'));
    const ffmpegConfig = ffmpeg['ffmpeg-static'];
    // A custom binary needs its own reviewed source/license records.
    if ([ffmpegConfig['binary-path-env-var'], ffmpegConfig['binary-release-tag-env-var'], ffmpegConfig['binaries-url-env-var']]
        .some((name) => process.env[name])) throw new Error('Custom FFmpeg builds require updated license and source records before packaging.');
    const binary = `ffmpeg${platform === 'win32' ? '.exe' : ''}`;
    // These files ship beside the unpacked FFmpeg binary; check, but don't copy.
    for (const name of ['LICENSE', `${binary}.LICENSE`, `${binary}.README`]) {
        if (!(await read(path.join(ffmpegDir, name))).trim()) throw new Error(`Missing FFmpeg notice: ${name}.`);
    }
    const output = path.join(root, 'vendor/licenses', target);
    await fs.mkdir(output, { recursive: true });
    // Remove obsolete catalogs and duplicate notices left by earlier builds.
    for (const name of ['SOURCE-INDEX.json', 'SOURCE-RECORDS.json', 'SOURCES.md', 'THIRD_PARTY_NOTICES.md', 'catalog.json', 'LICENSES.chromium.html']) {
        await fs.rm(path.join(output, name), { force: true });
    }
    await fs.writeFile(path.join(output, 'THIRD_PARTY_LICENSES.txt'), [...supplements.values()].map((item) =>
        `${[...item.components].join('\n')}\n\n${item.text}`).join('\n\n' + '='.repeat(80) + '\n\n'));
}

module.exports = { prepareLicenses };
