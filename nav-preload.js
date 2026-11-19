// Preload for the little floating Back / Forward overlay shown on websites.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('navApi', {
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  onState: (cb) => ipcRenderer.on('nav:state', (_, s) => cb(s))
});
