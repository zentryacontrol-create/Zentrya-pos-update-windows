const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pickerAPI', {
  onInit: (fn) => ipcRenderer.on('picker-init', (_, d) => fn(d)),
  onItems: (fn) => ipcRenderer.on('picker-items', (_, d) => fn(d)),
  choose: (id) => ipcRenderer.send('picker-choose', id),
  cancel: () => ipcRenderer.send('picker-cancel'),
});
