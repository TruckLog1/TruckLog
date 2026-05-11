const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  saveReceipt: (filename, html) => ipcRenderer.invoke('save-receipt', { filename, html }),
  checkPlugin: () => ipcRenderer.invoke('check-plugin'),
  autoInstallPlugin: () => ipcRenderer.invoke('auto-install-plugin'),
  getTelemetry: () => ipcRenderer.invoke('get-telemetry'),
  getAuthUrl: () => ipcRenderer.invoke('get-auth-url'),
  getAuthServer: () => ipcRenderer.invoke('get-auth-server'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onSteamAuth: (cb) => ipcRenderer.on('steam-auth', (_, url) => cb(url))
});
