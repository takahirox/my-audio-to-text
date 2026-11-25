const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('indicator', {
  onUpdate: callback => ipcRenderer.on('indicator:update', (_event, view) => callback(view)),
  stop: () => ipcRenderer.send('indicator:stop'),
  dismiss: () => ipcRenderer.send('indicator:dismiss'),
});
