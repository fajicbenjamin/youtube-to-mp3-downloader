const { app, Menu } = require('electron');

let appMenu;

function setMenu(actions = {}) {
    appMenu = Menu.buildFromTemplate([
        {
            label: 'Update yt-dlp now',
            enabled: Boolean(actions.updateDownloadEngine),
            click: () => actions.updateDownloadEngine?.()
        },
        {
            label: 'Restore bundled yt-dlp',
            enabled: Boolean(actions.restoreDownloadEngine),
            click: () => actions.restoreDownloadEngine?.()
        },
        { type: 'separator' },
        {
            label: 'About YouTube to MP3',
            enabled: Boolean(actions.showAbout),
            click: () => actions.showAbout?.()
        }
    ]);

    // Windows/Linux have only the in-app options button. macOS keeps its
    // system menu so standard editing and window keyboard shortcuts work.
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                { label: 'About YouTube to MP3', click: () => actions.showAbout?.() },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        { role: 'editMenu' },
        { role: 'windowMenu' }
    ]) : null);
}

function showAppMenu(window, position) {
    if (!appMenu || window.isDestroyed()) return Promise.resolve();
    const { width, height } = window.getContentBounds();
    const coordinate = (value, fallback, limit) => Math.max(0, Math.min(
        Number.isFinite(value) ? Math.round(value) : fallback, limit - 1
    ));
    return new Promise((resolve) => {
        appMenu.popup({
            window,
            x: coordinate(position?.x, 12, width),
            y: coordinate(position?.y, 40, height),
            callback: resolve
        });
    });
}

module.exports = { setMenu, showAppMenu };
