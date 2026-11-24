const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  get: () => ipcRenderer.invoke('management:get'),
  add: (name, graph) => ipcRenderer.invoke('management:add', name, graph),
  save: (id, revision, graph) => ipcRenderer.invoke('management:save', id, revision, graph),
  exportGraph: graph => ipcRenderer.invoke('management:export', graph),
  select: id => ipcRenderer.invoke('management:select', id),
  shortcut: value => ipcRenderer.invoke('management:shortcut', value),
  startLive: id => ipcRenderer.invoke('management:live', id),
  stop: () => ipcRenderer.invoke('management:stop'),
  cancel: () => ipcRenderer.invoke('management:cancel'),
  model: action => ipcRenderer.invoke('management:model', action),
  onUpdate: callback => ipcRenderer.on('management:update', (_event, view) => callback(view)),
  onNavigate: callback => ipcRenderer.on('management:navigate', (_event, page) => callback(page)),
  onDisplay: callback => ipcRenderer.on('management:display', (_event, update) => callback(update)),
  onModel: callback => ipcRenderer.on('management:model', (_event, view) => callback(view)),
});
