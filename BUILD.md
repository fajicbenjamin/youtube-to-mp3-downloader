# Building the app

## Requirements

- Git and Node.js 22.12 or newer, with npm.
- Internet access for npm packages and the Electron, FFmpeg and yt-dlp downloads.
- Build on the target operating system and architecture: `ffmpeg-static` installs a native binary.

## Install and run

```sh
git clone https://github.com/fajicbenjamin/youtube-to-mp3-downloader.git
cd youtube-to-mp3-downloader
npm ci
npm start
```

Keep npm install scripts enabled. To retry only the yt-dlp setup, run `npm run setup:downloader`. No separate Python, Deno or FFmpeg installation is needed.

## Package locally

```sh
npm run package
```

Packages are written to `dist/`; this command does not upload them. Windows produces an NSIS installer. macOS produces a DMG and the ZIP used by the app updater. Build separate macOS architecture packages, not a universal package.

The `beforePack` hook prepares the pinned yt-dlp distribution and adds any license notices missing from the packaged dependencies. Keep the downloader resources, unpacked FFmpeg binary and `resources/licenses/` in the package. Electron's `runAsNode` fuse must stay enabled because yt-dlp uses its Node runtime.

## Updating bundled tools

yt-dlp's bundled version and checksums are in `src/downloader-binaries.json`. When changing that version, refresh its license snapshots and `licenses/manifest.json` too. Update npm dependencies through `package.json` and `package-lock.json`, then run `npm ci`.

Packaging checks that installed dependencies match the lockfile and have license texts. Only supplemental notices are written to `resources/licenses/THIRD_PARTY_LICENSES.txt`; existing dependency licenses and Electron's notices remain in their packaged locations.
