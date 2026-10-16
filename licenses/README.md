# License texts

This folder supplies license texts missing from the packaged dependencies. `manifest.json` ties the snapshots to exact versions. Electron's own notices and dependencies' existing license files stay in their original packaged locations.

| Files | Origin |
| --- | --- |
| `yt-dlp-Unlicense.txt` | Upstream [yt-dlp 2026.08.19 LICENSE](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/LICENSE) |
| `yt-dlp-THIRD_PARTY_LICENSES.txt` | Upstream [yt-dlp 2026.08.19 notices](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/THIRD_PARTY_LICENSES.txt), used only when the downloaded distribution does not already provide a separate notice file (macOS/Linux) |
| `protobuf-Apache-2.0.txt` | [protobuf-es v2.16.0 LICENSE](https://github.com/bufbuild/protobuf-es/blob/v2.16.0/LICENSE) |
| `lazy-val-MIT.txt` | MIT terms and author attribution from lazy-val 1.0.5's published metadata; the package provides no license file |

`prepare-licenses.js` adds only missing notices to the package. It also preserves the MIT notices from dependency READMEs that electron-builder excludes; identical notices share one entry with all applicable package names.

No extra GPL text is needed: it is included in `ffmpeg-static/LICENSE` and yt-dlp's third-party notices. Protobuf's BSD notice remains in its packaged `dist/esm/wire/varint.js`; YouTube.js includes its own `LICENSE`. Upstream notices are retained without editing.

