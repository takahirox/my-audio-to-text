const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runtimeHost', {
  onCommand: callback => ipcRenderer.on('runtime:command', (_event, command) => callback(command)),
  ready: () => ipcRenderer.send('runtime:ready'),
  respond: result => ipcRenderer.send('runtime:response', result),
  insert: (id, text) => ipcRenderer.invoke('runtime:insert', id, text),
  failure: (id, message) => ipcRenderer.send('runtime:failure', id, message),
  captureEnded: id => ipcRenderer.send('runtime:capture-ended', id),
  display: (id, node, port, item, provisional) => ipcRenderer.send('runtime:display', id, node, port, item, provisional),
  modelProgress: view => ipcRenderer.send('runtime:model-progress', view),
});
