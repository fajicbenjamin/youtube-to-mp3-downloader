const {ipcRenderer} = require("electron");

// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// No Node.js APIs are available in this process because
// `nodeIntegration` is turned off. Use `preload.js` to
// selectively enable features needed in the rendering
// process.

let progressBarDiv = document.getElementsByClassName('meter')[0];
let progressBar = document.getElementById('progress-bar');

document.getElementById('download-button').addEventListener("click", function() {
    document.getElementById('status').innerText = 'Initializing';

    let params = {
        url: document.getElementById('url-input').value,
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

ipcRenderer.on('progress-status', (event, arg) => {
    if (progressBarDiv.style.display === 'none' && (arg !== 0 || arg !== 100))
        progressBarDiv.style.display = 'block';

    if (arg === 0 || arg === 100)
        progressBarDiv.style.display = 'none';

    progressBar.style.width = arg + '%';
});

document.getElementById('cover-search').addEventListener('click', function () {
    let searchInputDisplay = document.getElementById('cover-search-input');

    if (searchInputDisplay.style.display === 'none' || searchInputDisplay.style.display === '')
        searchInputDisplay.style.display = 'inline';
    else
        searchInputDisplay.style.display = 'none';
});