// Tiny bridge for the website toolbar (app/sitebar.html). Nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sitebar', {
  cmd: (name) => ipcRenderer.send('site:cmd', String(name)),   // 'back' | 'forward' | 'reload' | 'home'
  onState: (cb) => ipcRenderer.on('site:state', (_, s) => cb(s)),
  ready: () => ipcRenderer.send('site:ready')
});
