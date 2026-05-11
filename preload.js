const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  saveReceipt: (filename, html) => ipcRenderer.invoke('save-receipt', { filename, html }),
  checkPlugin: () => ipcRenderer.invoke('check-plugin'),
  autoInstallPlugin: () => ipcRenderer.invoke('auto-install-plugin'),
  getTelemetry: () => ipcRenderer.invoke('get-telemetry')
});
