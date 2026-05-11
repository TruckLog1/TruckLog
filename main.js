const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { execSync, exec } = require('child_process');

let mainWindow;

// PowerShell script - citeste SCSTelemetry shared memory
const PS_TELEMETRY = `
Add-Type @"
using System;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
public class SCSTelemetry {
    public static byte[] Read() {
        try {
            var mmf = MemoryMappedFile.OpenExisting("SCSTelemetry");
            var view = mmf.CreateViewAccessor(0, 32768);
            byte[] data = new byte[32768];
            view.ReadArray(0, data, 0, 32768);
            view.Dispose();
            mmf.Dispose();
            return data;
        } catch(Exception ex) {
            return null;
        }
    }
}
"@
$data = [SCSTelemetry]::Read()
if ($data -eq $null) { Write-Output "null"; exit }
$sdkActive = [BitConverter]::ToUInt32($data, 0)
if ($sdkActive -eq 0) { Write-Output "inactive"; exit }
$paused = [BitConverter]::ToUInt32($data, 4)
$speed = [Math]::Abs([BitConverter]::ToSingle($data, 72)) * 3.6
$odometer = [BitConverter]::ToSingle($data, 976)
$engineOn = $data[848]
$pausedBool = if ($paused -eq 1) { "true" } else { "false" }
$engineBool = if ($engineOn -eq 1) { "true" } else { "false" }
Write-Output ("{""active"":true,""paused"":$pausedBool,""speed"":$([Math]::Round($speed)),""odometer"":$([Math]::Round($odometer)),""engineOn"":$engineBool}")
`;

function readETS2Telemetry() {
  return new Promise((resolve) => {
    try {
      const psFile = path.join(os.tmpdir(), 'tl_tel.ps1');
      fs.writeFileSync(psFile, PS_TELEMETRY, 'utf8');
      exec(`powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`,
        { timeout: 3000 }, (err, stdout, stderr) => {
          if (err) { resolve(null); return; }
          const out = (stdout || '').trim();
          if (!out || out === 'null' || out === 'inactive') { resolve(null); return; }
          try { resolve(JSON.parse(out)); }
          catch(e) { resolve(null); }
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
  if (!pluginsPath) return { success: false, error: 'ETS2 nu a fost găsit pe PC' };
  if (!fs.existsSync(pluginsPath)) fs.mkdirSync(pluginsPath, { recursive: true });

  const zipPath = path.join(os.tmpdir(), 'scs-telemetry.zip');
  const extractPath = path.join(os.tmpdir(), 'scs_extract_' + Date.now());

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
            // Try different possible paths in the ZIP
            const candidates = [
              path.join(extractPath, 'release_v_1_12_1', 'Win64', 'scs-telemetry.dll'),
              path.join(extractPath, 'Win64', 'scs-telemetry.dll'),
              path.join(extractPath, 'win_x64', 'scs-telemetry.dll'),
              path.join(extractPath, 'scs-telemetry.dll'),
            ];
            // Also search recursively
            const found = candidates.find(c => fs.existsSync(c));
            if (found) {
              fs.copyFileSync(found, path.join(pluginsPath, 'scs-telemetry.dll'));
              resolve({ success: true });
            } else {
              // List what's in the extract path for debugging
              const files = execSync(`dir /s /b "${extractPath}"`, {encoding:'utf8'});
              resolve({ success: false, error: 'DLL negăsit. Fișiere găsite: ' + files.slice(0, 200) });
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
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
