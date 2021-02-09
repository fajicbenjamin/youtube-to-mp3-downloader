const {ipcRenderer} = require("electron");

// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// No Node.js APIs are available in this process because
// `nodeIntegration` is turned off. Use `preload.js` to
// selectively enable features needed in the rendering
// process.

if (localStorage.getItem('theme') === 'Dark')
    document.documentElement.classList.add('dark');

document.getElementById('download-button').addEventListener("click", function() {
    this.blur();

    let url = document.getElementById('url-input').value;

    if (!url)
        return;

    document.getElementById('status').innerText = 'Initializing';

    let params = {
        url: url,
        coverSearch: false,
        coverSearchTitle: ''
    };

    if (document.getElementById('cover-search').checked) {
        params.coverSearch = true;
        params.coverSearchTitle = document.getElementById('cover-search-url').value;
    }

    ipcRenderer.send('download-invoked', params)
});

ipcRenderer.on('download-status', (event, status, songTitle) => {
    if (status === 'Done') {
        new window.Notification('Successful download', {body: `${songTitle} has been successfully downloaded`});
        document.getElementById('status').innerText = '';
    } else {
        document.getElementById('status').innerText = status;
    }
});

ipcRenderer.on('show-data', (event, arg) => {
    let artworkElement = document.getElementById('song-artwork');
    let artistElement = document.getElementById('song-artist');
    let titleElement = document.getElementById('song-title');

    artworkElement.src = arg.cover;
    artistElement.innerText = arg.artist.join(', ');
    titleElement.innerText = arg.title;
});

document.getElementById('cover-search').addEventListener('click', function () {
    let searchInputDisplay = document.getElementById('cover-search-input');

    if (searchInputDisplay.style.display === 'none' || searchInputDisplay.style.display === '')
        searchInputDisplay.style.display = 'block';
    else
        searchInputDisplay.style.display = 'none';
});

ipcRenderer.on('theme-switch', (event, theme) => {
    let hasDark = document.documentElement.classList.contains('dark');

    if (theme === 'Dark' && !hasDark) {
        document.documentElement.classList.add('dark');
        localStorage.setItem('theme', theme)
    } else if (theme === 'Light' && hasDark) {
        document.documentElement.classList.remove('dark')
        localStorage.setItem('theme', theme)
    }
});

// updating application
ipcRenderer.on('update_downloaded', () => {
    ipcRenderer.removeAllListeners('update_downloaded');

    document.getElementById('update-box').classList.remove('hidden');
});

document.getElementById('update-button').addEventListener("click", function() {
    ipcRenderer.send('restart_app');
});