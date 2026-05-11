const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { execSync, exec } = require('child_process');
const AUTH_SERVER = 'https://trucklog-production.up.railway.app';

// Register trucklog:// protocol
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('trucklog', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('trucklog');
}

// Handle protocol on Windows
app.on('second-instance', (event, commandLine) => {
  const url = commandLine.find(arg => arg.startsWith('trucklog://'));
  if (url && mainWindow) {
    mainWindow.webContents.send('steam-auth', url);
    mainWindow.focus();
  }
});

let mainWindow;

function readETS2Telemetry() {
  return new Promise((resolve) => {
    try {
      const ps = `
Add-Type -TypeDefinition @"
using System;
using System.IO.MemoryMappedFiles;
public class TL {
    public static byte[] Read() {
        try {
            var m = MemoryMappedFile.OpenExisting("SCSTelemetry");
            var v = m.CreateViewAccessor(0, 32768);
            var d = new byte[32768];
            v.ReadArray(0, d, 0, 32768);
            v.Dispose(); m.Dispose();
            return d;
        } catch { return null; }
    }
}
"@
$d = [TL]::Read()
if ($d -eq $null) { Write-Output "NULL"; exit }
$sdk = [BitConverter]::ToUInt32($d, 0)
if ($sdk -eq 0) { Write-Output "INACTIVE"; exit }
$paused = [BitConverter]::ToUInt32($d, 4)
$speed = [Math]::Round([Math]::Abs([BitConverter]::ToSingle($d, 948)))
$odometer = [Math]::Round([BitConverter]::ToSingle($d, 1060) / 1000, 1)
$engine = $d[848]
$p = if ($paused -eq 1) { "true" } else { "false" }
$e = if ($engine -eq 1) { "true" } else { "false" }
Write-Output "OK|$speed|$odometer|$p|$e"
`;
      const psFile = path.join(os.tmpdir(), 'tl_read.ps1');
      fs.writeFileSync(psFile, ps, 'utf8');
      exec(`powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`,
        { timeout: 3000 }, (err, stdout) => {
          if (err || !stdout) { resolve(null); return; }
          const out = stdout.trim();
          if (out === 'NULL' || out === 'INACTIVE') { resolve(null); return; }
          if (out.startsWith('OK|')) {
            const parts = out.split('|');
            resolve({
              active: true,
              speed: parseInt(parts[1]) || 0,
              odometer: parseFloat(parts[2]) || 0,
              paused: parts[3] === 'true',
              engineOn: parts[4] === 'true'
            });
          } else { resolve(null); }
        });
    } catch(e) { resolve(null); }
  });
}

function findPluginsPath() {
  const bases = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Euro Truck Simulator 2\\bin\\win_x64\\plugins',
    'C:\\Program Files\\Steam\\steamapps\\common\\Euro Truck Simulator 2\\bin\\win_x64\\plugins',
  ];
  try {
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
  const dll = path.join(pluginsPath, 'scs-telemetry.dll');
  return { installed: fs.existsSync(dll), pluginsPath };
}

async function autoInstallPlugin() {
  const pluginsPath = findPluginsPath();
  if (!pluginsPath) return { success: false, error: 'ETS2 nu a fost gasit pe PC' };
  if (!fs.existsSync(pluginsPath)) fs.mkdirSync(pluginsPath, { recursive: true });
  const zipPath = path.join(os.tmpdir(), 'scs-telemetry.zip');
  const extractPath = path.join(os.tmpdir(), 'scs_ex_' + Date.now());
  return new Promise((resolve) => {
    const download = (url) => {
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) { download(res.headers.location); return; }
        const file = fs.createWriteStream(zipPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          try {
            execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractPath}' -Force"`);
            const candidates = [
              path.join(extractPath, 'release_v_1_12_1', 'Win64', 'scs-telemetry.dll'),
              path.join(extractPath, 'Win64', 'scs-telemetry.dll'),
              path.join(extractPath, 'scs-telemetry.dll'),
            ];
            const found = candidates.find(c => fs.existsSync(c));
            if (found) {
              fs.copyFileSync(found, path.join(pluginsPath, 'scs-telemetry.dll'));
              resolve({ success: true });
            } else {
              resolve({ success: false, error: 'DLL negasit in arhiva' });
            }
          } catch(e) { resolve({ success: false, error: e.message }); }
        });
      }).on('error', (e) => resolve({ success: false, error: e.message }));
    };
    download('https://github.com/RenCloud/scs-sdk-plugin/releases/download/V.1.12.1/scs-sdk-plugin.zip');
  });
}

ipcMain.handle('check-plugin', () => checkPlugin());
ipcMain.handle('auto-install-plugin', () => autoInstallPlugin());
ipcMain.handle('get-telemetry', () => readETS2Telemetry());
ipcMain.handle('get-auth-url', () => `${AUTH_SERVER}/auth/steam`);
ipcMain.handle('get-auth-server', () => AUTH_SERVER);
ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
  return true;
});
ipcMain.handle('save-receipt', async (_, { filename, html }) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salveaza bon', defaultPath: filename,
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
 mainWindow.once('ready-to-show', () => {
  mainWindow.show();
  setTimeout(() => {
    try {
      const pluginCheck = checkPlugin();
      if (!pluginCheck.installed && !pluginCheck.noEts2) {
        autoInstallPlugin().then(result => {
          if (result.success) {
            mainWindow.webContents.send('plugin-installed', true);
          }
        });
      }
    } catch(e) { console.log('Plugin check error:', e.message); }
  }, 3000);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
