// Modules to control application life and create native browser window
const {app, BrowserWindow, ipcMain} = require('electron');
const { autoUpdater } = require('electron-updater');

const downloader = require('./src/downloader');
const menuBuilder = require('./src/menuBuilder');

app.disableHardwareAcceleration();
app.setAsDefaultProtocolClient('yt2mp3app');

let deepLinkUrl
let mainWindow

const gotTheLock = app.requestSingleInstanceLock()
if (gotTheLock) {
  app.on('second-instance', (e, argv) => {
    // Someone tried to run a second instance, we should focus our window.

    // Protocol handler for win32
    // argv: An array of the second instance’s (command line / deep linked) arguments
    if (process.platform === 'win32') {
      // Keep only command line / deep linked arguments
      deepLinkUrl = argv.slice(2)
      downloadFromDeepLink(deepLinkUrl)
    }

    if (mainWindow) {
      if (mainWindow.isMinimized())
        mainWindow.restore()

      mainWindow.focus()
    }
  })
} else {
  app.quit()
  return
}

function createWindow () {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // and load the index.html of the app.
  mainWindow.loadFile('index.html').then(r => {
    // Protocol handler for win32
    if (process.platform === 'win32') {
      // Keep only command line / deep linked arguments
      deepLinkUrl = process.argv.slice(1)
    }

    downloadFromDeepLink(deepLinkUrl);
  })

  // Open the DevTools.
  // mainWindow.webContents.openDevTools()

  // Emitted when the window is closed.
  mainWindow.on('closed', function() {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null
  })

  menuBuilder.setMenu();
}

// Protocol handler for osx when creating first instance
// only set deeplink url, and leave it to create window as usual
app.on('open-url', function(event, url) {
  event.preventDefault();
  deepLinkUrl = url;
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {

  ipcMain.on('download-invoked', (event, url) => {
    downloader.startDownload(url, event);
  });

  ipcMain.on('restart_app', () => {
    autoUpdater.quitAndInstall();
  });

  createWindow()
  
  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    deepLinkUrl = '';
    if (BrowserWindow.getAllWindows().length === 0 || mainWindow === null) createWindow()
  })

  // Protocol handler for osx when app was already running
  app.on('open-url', function(event, url) {
    if (!mainWindow) createWindow();
    event.preventDefault();
    deepLinkUrl = url;
    downloadFromDeepLink(deepLinkUrl);
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
app.on('ready', function()  {
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-downloaded', () => {
    BrowserWindow.getFocusedWindow().webContents.send('update_downloaded');
  });
});

function downloadFromDeepLink(deepLink) {
  const protocolClient = 'yt2mp3app://';
  let param = deepLink.toString().substring(protocolClient.length);

  mainWindow.webContents.send('deeplink_download', param);
}
