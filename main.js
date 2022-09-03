// Modules to control application life and create native browser window
const {app, BrowserWindow, ipcMain} = require('electron');
const { autoUpdater } = require('electron-updater');

const downloader = require('./src/downloader');
const menuBuilder = require('./src/menuBuilder');

app.disableHardwareAcceleration();

let deepLinkUrl
let mainWindow

// Force Single Instance Application
const gotTheLock = app.requestSingleInstanceLock()
if (gotTheLock) {
  app.on('second-instance', (e, argv) => {
    // Someone tried to run a second instance, we should focus our window.

    // Protocol handler for win32
    // argv: An array of the second instance’s (command line / deep linked) arguments
    if (process.platform === 'win32') {
      // Keep only command line / deep linked arguments
      deepLinkUrl = argv.slice(2)
      downloadFromDeepLink(deepLinkUrl, mainWindow)
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
      downloadFromDeepLink(deepLinkUrl, mainWindow)
    }
  })

  // Open the DevTools.
  // mainWindow.webContents.openDevTools()

  menuBuilder.setMenu();
}

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
    if (BrowserWindow.getAllWindows().length === 0 || mainWindow === null) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})

if (!app.isDefaultProtocolClient('yt2mp3app')) {
  // Define custom protocol handler. Deep linking works on packaged versions of the application!
  app.setAsDefaultProtocolClient('yt2mp3app')
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
app.on('ready', function()  {
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-downloaded', () => {
    BrowserWindow.getFocusedWindow().webContents.send('update_downloaded');
  });
});

function downloadFromDeepLink(deepLink, mainWindow) {
  const protocolClient = 'yt2mp3app://';
  let param = deepLink.toString().substring(protocolClient.length);

  mainWindow.webContents.send('deeplink_download', param);
}
