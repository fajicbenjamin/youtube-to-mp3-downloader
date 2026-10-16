const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
    const listener = (event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('downloader', {
    platform: process.platform,
    download: (params) => ipcRenderer.send('download-invoked', params),
    openDownloads: () => ipcRenderer.send('open-downloads'),
    revealDownload: () => ipcRenderer.send('reveal-download'),
    installUpdate: () => ipcRenderer.send('restart-app'),
    setWindowTheme: (theme) => ipcRenderer.send('window-theme', theme),
    setWindowModalDepth: (depth) => ipcRenderer.send('window-modal-depth', depth),
    showAppMenu: (position) => ipcRenderer.invoke('show-app-menu', position),
    openProjectLink: (key) => ipcRenderer.invoke('open-project-link', key),
    ready: () => ipcRenderer.send('renderer-ready'),
    onState: (callback) => subscribe('download-state', callback),
    onEngineState: (callback) => subscribe('download-engine-state', callback),
    onComplete: (callback) => subscribe('download-complete', callback),
    onAbout: (callback) => subscribe('show-about', callback),
    onUpdate: (callback) => subscribe('update-downloaded', callback)
});
