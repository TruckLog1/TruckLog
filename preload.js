const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  saveReceipt: (filename, html) => ipcRenderer.invoke('save-receipt', { filename, html })
});
