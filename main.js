const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { execSync, exec } = require('child_process');

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
  try {
    // Copy DLL from app resources
    const dllSrc = path.join(__dirname, 'scs-telemetry.dll');
    const dllDest = path.join(pluginsPath, 'scs-telemetry.dll');
    if (!fs.existsSync(dllSrc)) return { success: false, error: 'DLL negasit in aplicatie' };
    fs.copyFileSync(dllSrc, dllDest);
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

ipcMain.handle('check-plugin', () => checkPlugin());
ipcMain.handle('auto-install-plugin', () => autoInstallPlugin());
ipcMain.handle('get-telemetry', () => readETS2Telemetry());
ipcMain.handle('get-auth-url', () => 'https://trucklog-production.up.railway.app/auth/steam');
ipcMain.handle('get-auth-server', () => 'https://trucklog-production.up.railway.app');
ipcMain.handle('open-external', (_, url) => { shell.openExternal(url); return true; });
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
            if (result.success && mainWindow) {
              mainWindow.webContents.send('plugin-installed', true);
            }
          });
        }
      } catch(e) { console.log('Plugin check:', e.message); }
    }, 3000);
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
