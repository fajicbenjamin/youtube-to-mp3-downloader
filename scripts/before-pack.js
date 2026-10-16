const { prepareDownloader } = require('./prepare-downloader');
const { prepareLicenses } = require('./prepare-licenses');

module.exports = async (context) => {
    // Electron Builder's Arch enum: ia32, x64, armv7l, arm64, universal.
    const arch = typeof context.arch === 'string' ? context.arch : ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][context.arch];
    await prepareDownloader(context.electronPlatformName, arch);
    await prepareLicenses(context.electronPlatformName, arch);
};
