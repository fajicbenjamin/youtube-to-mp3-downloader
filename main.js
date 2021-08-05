// Modules to control application life and create native browser window
const {app, BrowserWindow, ipcMain} = require('electron');
const { autoUpdater } = require('electron-updater');

const downloader = require('./src/downloader');
const menuBuilder = require('./src/menuBuilder');

function createWindow () {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    resizable: false,
    webPreferences: {
      nodeIntegration: true
    }
  });

  // and load the index.html of the app.
  mainWindow.loadFile('index.html')

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
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
  // autoUpdater.checkForUpdates().then()
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-downloaded', () => {
    BrowserWindow.getFocusedWindow().webContents.send('update_downloaded');
  });
});
