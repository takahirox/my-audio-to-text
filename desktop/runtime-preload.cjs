const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runtimeHost', {
  onCommand: callback => ipcRenderer.on('runtime:command', (_event, command) => callback(command)),
  ready: () => ipcRenderer.send('runtime:ready'),
  respond: result => ipcRenderer.send('runtime:response', result),
  insert: (id, text) => ipcRenderer.invoke('runtime:insert', id, text),
  failure: (id, message) => ipcRenderer.send('runtime:failure', id, message),
  captureState: (id, capturing, message) => ipcRenderer.send('runtime:capture-state', id, capturing, message),
  display: (id, node, port, item, provisional) => ipcRenderer.send('runtime:display', id, node, port, item, provisional),
  floatingDisplay: (id, text) => ipcRenderer.send('runtime:floating-display', id, text),
  microphone: id => ipcRenderer.invoke('runtime:microphone', id),
  status: (...args) => ipcRenderer.send('runtime:status', ...args),
  actions: (...args) => ipcRenderer.send('runtime:actions', ...args),
  audio: (...args) => ipcRenderer.send('runtime:audio', ...args),
  preparation: (...args) => ipcRenderer.send('runtime:preparation', ...args),
  modelProgress: (...args) => ipcRenderer.send('runtime:model-progress', ...args),
});
