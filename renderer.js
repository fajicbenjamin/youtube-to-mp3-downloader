const {ipcRenderer} = require("electron");

// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// No Node.js APIs are available in this process because
// `nodeIntegration` is turned off. Use `preload.js` to
// selectively enable features needed in the rendering
// process.

// document.getElementById('status').innerText = '';

let progressBarDiv = document.getElementsByClassName('meter')[0];
let progressBar = document.getElementById('progress-bar');

document.getElementById('download-button').addEventListener("click", function() {
    document.getElementById('status').innerHTML = 'Initializing';
    ipcRenderer.send('download-invoked', document.getElementById('url-input').value)
});

ipcRenderer.on('download-status', (event, arg) => {
    document.getElementById('status').innerHTML = arg
});

ipcRenderer.on('progress-status', (event, arg) => {
    if (progressBarDiv.style.display === 'none' && (arg !== 0 || arg !== 100))
        progressBarDiv.style.display = 'block';

    if (arg === 0 || arg === 100)
        progressBarDiv.style.display = 'none';

    progressBar.style.width = arg + '%';
});