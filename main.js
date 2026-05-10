const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('ignore-certificate-errors');

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
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true
    },
    autoHideMenuBar: true,
    show: false
  });

  // Remove ALL content security policy headers
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"]
      }
    });
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.webContents.openDevTools();
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.log('Load error:', code, desc, url);
  });
}

ipcMain.handle('save-receipt', async (_, { filename, html }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvează bon',
    defaultPath: filename,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (filePath) { fs.writeFileSync(filePath, html, 'utf8'); return true; }
  return false;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
