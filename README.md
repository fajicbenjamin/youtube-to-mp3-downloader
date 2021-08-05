<div align="center">

![logo](assets/app-icon/png/128.png)

# Youtube to MP3 Downloader

![GitHub release (latest by date)](https://img.shields.io/github/v/release/fajicbenjamin/youtube-to-mp3-downloader) ![GitHub all releases](https://img.shields.io/github/downloads/fajicbenjamin/youtube-to-mp3-downloader/total) ![GitHub](https://img.shields.io/github/license/fajicbenjamin/youtube-to-mp3-downloader)
  
  </div>

This is a minimal Electron application based on the [Quick Start Guide](https://electronjs.org/docs/tutorial/quick-start) within the Electron documentation.

It takes YouTube song url and downloads it as .mp3 file to your computer. Files can be tagged with cover artwork, artist, and other MP3 tags if wanted.

If you already have downloaded bunch of MP3s that you want to write tags to, you can use this [project](https://github.com/fajicbenjamin/mp3-metadata-app) instead.

## To Use

To clone and run this repository you'll need [Git](https://git-scm.com) and [Node.js](https://nodejs.org/en/download/) (which comes with [npm](http://npmjs.com)) installed on your computer. From your command line:

```bash
# Clone this repository
git clone https://github.com/fajicbenjamin/youtube-to-mp3-downloader.git

# Go into the repository
cd youtube-to-mp3-downloader

# Install dependencies
npm install

# Compile Tailwind
npx tailwindcss-cli@latest build -o tailwind.css

# Run the app
npm start

# To package it for Windows or macOS
npm run package
```

Note: If you're using Linux Bash for Windows, [see this guide](https://www.howtogeek.com/261575/how-to-run-graphical-linux-desktop-applications-from-windows-10s-bash-shell/) or use `node` from the command prompt.

## Download

You can download already packaged releases for Windows or macOS. Here is [latest release](https://github.com/fajicbenjamin/youtube-to-mp3-downloader/releases/latest).

## Disclaimer
This app shouldn't be used on copyrighted material.
