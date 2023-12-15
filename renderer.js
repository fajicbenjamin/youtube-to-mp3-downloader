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

ipcRenderer.on('show-data', (event, arg) => {
    let artworkElement = document.getElementById('song-artwork');
    let artistElement = document.getElementById('song-artist');
    let titleElement = document.getElementById('song-title');

    artworkElement.src = arg.cover;
    artistElement.innerText = arg.artist.join(', ');
    titleElement.innerText = arg.title;
});

ipcRenderer.on('playlist-status', (event, status) => {
        document.getElementById('playlist').innerText = status;
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
ipcRenderer.on('update_downloaded', (info, event) => {
    ipcRenderer.removeAllListeners('update_downloaded');

    toggleModal();
    document.getElementById('update-version').innerText = event.tag;
    document.getElementById('changelog').innerHTML = event.releaseNotes;
});

document.getElementById('accept-update').addEventListener('click', function () {
    ipcRenderer.send('restart_app');
});

// deep linking start download
ipcRenderer.on('deeplink_download', (event, url) => {
    document.getElementById('url-input').value = url;
    document.getElementById('download-button').click();
});

ipcRenderer.on('download-progress', (event, data) => {
    ipcRenderer.send('download-progress', data);
    document.getElementById('progress').style.width = data + '%';
    document.getElementById('progress-label').innerText = data + '%';

    if (data === 0) {
        document.getElementById('progress-label').innerText = '';
        document.getElementById('progress-title').innerText = '';
    } else {
        document.getElementById('progress-title').innerText = 'Progress';
    }
});


const overlay = document.querySelector('.modal-overlay')
overlay.addEventListener('click', toggleModal)

let closeModal = document.querySelectorAll('.modal-close')
for (let i = 0; i < closeModal.length; i++) {
    closeModal[i].addEventListener('click', toggleModal)
}

document.onkeydown = function(evt) {
    evt = evt || window.event
    let isEscape = false
    if ("key" in evt) {
        isEscape = (evt.key === "Escape" || evt.key === "Esc")
    } else {
        isEscape = (evt.keyCode === 27)
    }
    if (isEscape && document.body.classList.contains('modal-active')) {
        toggleModal()
    }
};

function toggleModal () {
    const body = document.querySelector('body')
    const modal = document.querySelector('.modal')
    modal.classList.toggle('opacity-0')
    modal.classList.toggle('pointer-events-none')
    body.classList.toggle('modal-active')
}