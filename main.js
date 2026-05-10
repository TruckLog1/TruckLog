const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    title: 'TruckLog',
    backgroundColor: '#0a0d14',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    },
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Save receipt HTML
ipcMain.handle('save-receipt', async (_, { filename, html }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvează bon',
    defaultPath: filename,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (filePath) {
    fs.writeFileSync(filePath, html, 'utf8');
    shell.openPath(filePath);
    return true;
  }
  return false;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
