const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const downloader = require('./src/downloader');
const downloadEngine = require('./src/download-engine');
const { stopTools } = require('./src/tool-processes');
const { parseInput } = require('./src/youtube');
const menuBuilder = require('./src/menu-builder');
const appMetadata = require('./package.json');
const projectLinks = {
    project: 'https://github.com/fajicbenjamin/youtube-to-mp3-downloader',
    issues: 'https://github.com/fajicbenjamin/youtube-to-mp3-downloader/issues',
    author: 'https://github.com/fajicbenjamin'
};

const PROTOCOL_CLIENT = 'yt2mp3app';
const protocolPrefix = `${PROTOCOL_CLIENT}://`;
const TITLE_BAR_HEIGHT = 40;
const windowColors = {
    Light: { color: '#f4f5f8', symbolColor: '#212332' },
    Dark: { color: '#171820', symbolColor: '#f0eff7' }
};
const queue = [];
const pendingLinks = process.argv.filter((arg) => arg.startsWith(protocolPrefix));
let mainWindow;
let processing = false;
let downloadedUpdate;
let lastSavedPath;
let state = idleState();
let engineStatus;
let engineTask;
let pendingEngineAction;
let engineTimer;
let quitting = false;
let windowTheme;
let modalDepth = 0;

function idleState() {
    return { busy: false, status: 'Ready when you are', progress: 0, playlist: '', song: null, warnings: [], error: '', queued: 0 };
}

app.disableHardwareAcceleration();
if (process.defaultApp) {
    if (process.argv[1]) app.setAsDefaultProtocolClient(PROTOCOL_CLIENT, process.execPath, [path.resolve(process.argv[1])]);
} else {
    app.setAsDefaultProtocolClient(PROTOCOL_CLIENT);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
}

function send(channel, ...args) {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(channel, ...args);
    }
}

function publishState() {
    state.queued = queue.length;
    send('download-state', { ...state, canReveal: Boolean(lastSavedPath) });
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setProgressBar(!state.busy ? -1 : state.progress === null ? 2 : state.progress / 100);
    }
}

function publishEngineStatus(next) {
    engineStatus = next;
    send('download-engine-state', engineStatus);
}

function requestEngineAction(action = 'automatic') {
    if (quitting) return;
    if (processing || engineTask) {
        if (action !== 'automatic') {
            pendingEngineAction = action;
            publishEngineStatus({ ...engineStatus, message: processing
                ? 'Engine maintenance will run when your downloads finish.'
                : 'Engine maintenance is already running; your request is queued.' });
        }
        return;
    }
    pendingEngineAction = null;
    engineTask = (action === 'restore' ? downloadEngine.restoreBundled()
        : downloadEngine.checkForUpdates({ force: action === 'update' }))
        .catch((error) => publishEngineStatus({ ...engineStatus, busy: false, message: error.message }))
        .finally(() => {
            engineTask = null;
            if (pendingEngineAction && !processing) requestEngineAction(pendingEngineAction);
        });
}

function onDownloadEvent(channel, ...args) {
    if (channel === 'download-status') {
        state.status = args[0] === 'Done' ? 'Saved to Downloads' : args[0];
        if (args[0] === 'Done') {
            lastSavedPath = args[2];
            send('download-complete', args[1]);
        }
    } else if (channel === 'download-progress') {
        state.progress = args[0];
    } else if (channel === 'show-data') {
        state.song = args[0];
    } else if (channel === 'playlist-status') {
        state.playlist = args[0];
    } else if (channel === 'download-warning') {
        state.warnings.push(args[0]);
    }
    publishState();
}

function enqueueDownload(params) {
    try {
        parseInput(params?.url);
        if (params.coverSearch && (typeof params.coverSearchTitle !== 'string' || !params.coverSearchTitle.trim())) {
            throw new Error('Enter an artist or song title for the tag search.');
        }
        queue.push({
            url: params.url.trim(),
            coverSearch: Boolean(params.coverSearch),
            coverSearchTitle: typeof params.coverSearchTitle === 'string' ? params.coverSearchTitle.trim() : ''
        });
        publishState();
        void processQueue();
    } catch (error) {
        if (processing) state.warnings.push(downloader.errorMessage(error));
        else {
            state.error = downloader.errorMessage(error);
            state.status = 'Check your link';
        }
        publishState();
    }
}

async function processQueue() {
    if (processing) return;
    processing = true;
    try {
        while (queue.length && !quitting) {
            const params = queue.shift();
            state = { ...idleState(), busy: true, progress: null, status: 'Preparing download', url: params.url };
            publishState();
            try {
                await downloader.startDownload(params, onDownloadEvent);
            } catch (error) {
                state.error = downloader.errorMessage(error);
                state.status = 'Download failed';
                state.progress = 0;
            } finally {
                state.busy = false;
                publishState();
            }
        }
    } finally {
        processing = false;
        requestEngineAction(pendingEngineAction || 'automatic');
    }
}

function acceptDeepLink(link) {
    if (!link.startsWith(protocolPrefix)) return;
    let url = link.slice(protocolPrefix.length);
    // The companion extension can pass a literal or URI-encoded YouTube URL.
    if (/^https?%3a/i.test(url)) {
        try { url = decodeURIComponent(url); } catch { /* Validation below reports malformed links. */ }
    }
    enqueueDownload({ url });
}

function updateWindowControls() {
    if (!mainWindow || mainWindow.isDestroyed() || process.platform === 'darwin') return;
    const colors = windowColors[windowTheme || (nativeTheme.shouldUseDarkColors ? 'Dark' : 'Light')];
    // Native controls sit above the web backdrop. Match its tint explicitly;
    // keep this color/opacity in sync with dialog::backdrop in styles.css.
    const backdrop = [0x11, 0x14, 0x25];
    const opacity = 1 - Math.pow(0.4, modalDepth);
    const tint = (color) => `#${backdrop.map((channel, index) => {
        const original = parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);
        return Math.round(original * (1 - opacity) + channel * opacity).toString(16).padStart(2, '0');
    }).join('')}`;
    mainWindow.setTitleBarOverlay({
        color: tint(colors.color), symbolColor: tint(colors.symbolColor), height: TITLE_BAR_HEIGHT
    });
}

function setWindowTheme(theme) {
    if (theme !== 'Light' && theme !== 'Dark') return;
    windowTheme = theme;
    nativeTheme.themeSource = theme.toLowerCase();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const colors = windowColors[theme];
    mainWindow.setBackgroundColor(colors.color);
    updateWindowControls();
}

function showAbout() {
    if (!mainWindow) createWindow();
    const window = mainWindow;
    if (window.webContents.isLoadingMainFrame()) {
        window.webContents.once('did-finish-load', () => {
            if (mainWindow === window && !window.isDestroyed()) showAbout();
        });
        return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    send('show-about', { version: app.getVersion(), author: appMetadata.author.name });
}

function createWindow() {
    modalDepth = 0;
    const colors = windowColors[windowTheme || (nativeTheme.shouldUseDarkColors ? 'Dark' : 'Light')];
    mainWindow = new BrowserWindow({
        width: 980,
        height: 740,
        minWidth: 760,
        minHeight: 620,
        backgroundColor: colors.color,
        titleBarStyle: 'hidden',
        ...(process.platform === 'darwin'
            ? { trafficLightPosition: { x: 16, y: 13 } }
            : { titleBarOverlay: { ...colors, height: TITLE_BAR_HEIGHT } }),
        icon: path.join(__dirname, 'assets/app-icon/png/256.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        },
        show: false
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    // Reloads or renderer crashes must not leave the native buttons dimmed.
    const resetModalAppearance = () => {
        modalDepth = 0;
        updateWindowControls();
    };
    mainWindow.webContents.on('did-start-loading', resetModalAppearance);
    mainWindow.webContents.on('render-process-gone', resetModalAppearance);
    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('second-instance', (event, argv) => {
    const links = argv.filter((arg) => arg.startsWith(protocolPrefix));
    if (!app.isReady()) pendingLinks.push(...links);
    else {
        if (!mainWindow) createWindow();
        links.forEach(acceptDeepLink);
    }
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on('open-url', (event, url) => {
    event.preventDefault();
    if (!app.isReady()) pendingLinks.push(url);
    else {
        if (!mainWindow) createWindow();
        mainWindow.show();
        mainWindow.focus();
        acceptDeepLink(url);
    }
});

app.whenReady().then(() => {
    downloadEngine.subscribe(publishEngineStatus);
    const fromMainWindow = (event) => mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
    ipcMain.on('download-invoked', (event, params) => {
        if (fromMainWindow(event)) enqueueDownload(params);
    });
    ipcMain.on('renderer-ready', (event) => {
        if (!fromMainWindow(event)) return;
        publishState();
        if (engineStatus) send('download-engine-state', engineStatus);
        if (downloadedUpdate) send('update-downloaded', downloadedUpdate);
    });
    ipcMain.on('open-downloads', (event) => {
        if (!fromMainWindow(event)) return;
        const showOpenError = (message) => {
            state.error = `Could not open Downloads: ${message}`;
            publishState();
        };
        shell.openPath(app.getPath('downloads')).then((error) => {
            if (error) showOpenError(error);
        }).catch((error) => showOpenError(downloader.errorMessage(error)));
    });
    ipcMain.on('reveal-download', (event) => {
        if (fromMainWindow(event) && lastSavedPath) shell.showItemInFolder(lastSavedPath);
    });
    ipcMain.on('restart-app', (event) => {
        if (fromMainWindow(event) && downloadedUpdate && !processing) autoUpdater.quitAndInstall();
    });
    ipcMain.on('window-theme', (event, theme) => {
        if (fromMainWindow(event)) setWindowTheme(theme);
    });
    ipcMain.on('window-modal-depth', (event, depth) => {
        if (!fromMainWindow(event) || !Number.isInteger(depth) || depth < 0 || depth > 2) return;
        modalDepth = depth;
        updateWindowControls();
    });
    ipcMain.handle('show-app-menu', (event, position) => {
        if (fromMainWindow(event)) return menuBuilder.showAppMenu(mainWindow, position);
    });
    ipcMain.handle('open-project-link', async (event, key) => {
        if (!fromMainWindow(event) || typeof key !== 'string' || !Object.hasOwn(projectLinks, key)) return false;
        try {
            await shell.openExternal(projectLinks[key]);
            return true;
        } catch {
            return false;
        }
    });

    menuBuilder.setMenu({
        updateDownloadEngine: () => requestEngineAction('update'),
        restoreDownloadEngine: () => requestEngineAction('restore'),
        showAbout
    });
    createWindow();
    pendingLinks.splice(0).forEach(acceptDeepLink);
    void downloadEngine.getTools().then(() => requestEngineAction()).catch((error) => {
        publishEngineStatus({ ...engineStatus, message: error.message });
    });
    // The updater persists its daily check time; this also covers apps left
    // open for several days. Active downloads defer the next check.
    engineTimer = setInterval(() => requestEngineAction(), 60 * 60 * 1000);
    engineTimer.unref();
    autoUpdater.on('error', (error) => console.error('Update check failed:', error.message));
    autoUpdater.on('update-downloaded', (info) => {
        downloadedUpdate = { version: info.version, releaseNotes: info.releaseNotes };
        send('update-downloaded', downloadedUpdate);
    });
    if (app.isPackaged) {
        autoUpdater.checkForUpdatesAndNotify().catch((error) => console.error('Update check failed:', error.message));
    }
});

app.on('activate', () => {
    if (app.isReady() && !mainWindow) createWindow();
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
    quitting = true;
    clearInterval(engineTimer);
    downloadEngine.stopUpdates();
    downloader.stopDownloads();
    stopTools();
});
