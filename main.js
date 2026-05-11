const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');

let mainWindow;
let ffi, ref;
let telemetryAvailable = false;

function initTelemetry() {
  try {
    ffi = require('ffi-napi');
    ref = require('ref-napi');
    telemetryAvailable = true;
    console.log('[TruckLog] Telemetry ready');
  } catch(e) {
    telemetryAvailable = false;
  }
}

function readETS2Telemetry() {
  if (!ffi || !ref) return null;
  try {
    const kernel32 = ffi.Library('kernel32', {
      'OpenFileMappingA': ['pointer', ['uint32', 'bool', 'string']],
      'MapViewOfFile': ['pointer', ['pointer', 'uint32', 'uint32', 'uint32', 'size_t']],
      'UnmapViewOfFile': ['bool', ['pointer']],
      'CloseHandle': ['bool', ['pointer']]
    });

    const handle = kernel32.OpenFileMappingA(0x0004, false, 'Local\\SCSTelemetry');
    if (handle.isNull()) return null;

    const view = kernel32.MapViewOfFile(handle, 0x0004, 0, 0, 32768);
    if (view.isNull()) { kernel32.CloseHandle(handle); return null; }

    const buf = Buffer.alloc(32768);
    view.copy(buf, 0, 0, 32768);
    kernel32.UnmapViewOfFile(view);
    kernel32.CloseHandle(handle);

    const sdkActive = buf.readUInt32LE(0);
    if (!sdkActive) return null;

    return {
      active: true,
      paused: buf.readUInt32LE(4) === 1,
      speed: Math.round(Math.abs(buf.readFloatLE(72)) * 3.6),
      odometer: Math.round(buf.readFloatLE(976)),
      engineOn: buf.readUInt8(848) === 1
    };
  } catch(e) { return null; }
}

function findPluginsPath() {
  const bases = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Euro Truck Simulator 2\\bin\\win_x64\\plugins',
    'C:\\Program Files\\Steam\\steamapps\\common\\Euro Truck Simulator 2\\bin\\win_x64\\plugins',
  ];
  try {
    const { execSync } = require('child_process');
    const steamPath = execSync('reg query "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath 2>nul', {encoding:'utf8'})
      .match(/InstallPath\s+REG_SZ\s+(.+)/)?.[1]?.trim();
    if (steamPath) bases.unshift(path.join(steamPath, 'steamapps', 'common', 'Euro Truck Simulator 2', 'bin', 'win_x64', 'plugins'));
  } catch(e) {}
  for (const p of bases) {
    if (fs.existsSync(path.dirname(p))) return p;
  }
  return null;
}

function checkPlugin() {
  const pluginsPath = findPluginsPath();
  if (!pluginsPath) return { installed: false, noEts2: true };
  const dll = path.join(pluginsPath, 'scs-sdk-plugin.dll');
  return { installed: fs.existsSync(dll), pluginsPath };
}

async function autoInstallPlugin() {
  const pluginsPath = findPluginsPath();
  if (!pluginsPath) return { success: false, error: 'ETS2 nu a fost găsit pe PC' };
  if (!fs.existsSync(pluginsPath)) fs.mkdirSync(pluginsPath, { recursive: true });

  const zipPath = path.join(os.tmpdir(), 'scs-sdk-plugin.zip');
  const url = 'https://github.com/RenCloud/scs-sdk-plugin/releases/download/V.1.12.1/scs-sdk-plugin.zip';

  return new Promise((resolve) => {
    const download = (downloadUrl) => {
      https.get(downloadUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { download(res.headers.location); return; }
        const file = fs.createWriteStream(zipPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          try {
            const { execSync } = require('child_process');
            const extractPath = path.join(os.tmpdir(), 'scs_extract');
            execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractPath}' -Force"`);
            const dll = path.join(extractPath, 'win_x64', 'scs-sdk-plugin.dll');
            if (fs.existsSync(dll)) {
              fs.copyFileSync(dll, path.join(pluginsPath, 'scs-sdk-plugin.dll'));
              resolve({ success: true });
            } else {
              resolve({ success: false, error: 'DLL negăsit în arhivă' });
            }
          } catch(e) { resolve({ success: false, error: e.message }); }
        });
      }).on('error', (e) => resolve({ success: false, error: e.message }));
    };
    download(url);
  });
}

ipcMain.handle('check-plugin', () => checkPlugin());
ipcMain.handle('auto-install-plugin', () => autoInstallPlugin());
ipcMain.handle('get-telemetry', () => readETS2Telemetry());
ipcMain.handle('save-receipt', async (_, { filename, html }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvează bon', defaultPath: filename,
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (filePath) { fs.writeFileSync(filePath, html, 'utf8'); shell.openPath(filePath); return true; }
  return false;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366, height: 820, minWidth: 1024, minHeight: 640,
    title: 'TruckLog', backgroundColor: '#0a0d14',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, allowRunningInsecureContent: true
    },
    autoHideMenuBar: true, show: false
  });

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"] } });
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); initTelemetry(); });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
