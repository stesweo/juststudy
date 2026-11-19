// Exposes a small, fixed Google Tasks bridge to the page (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('gtasks', {
  status: call('gt:status'),   // -> { configured, signedIn }
  signIn: call('gt:signIn'),   // (mode: 'app' | 'browser')
  signOut: call('gt:signOut'),
  lists: call('gt:lists'),
  tasks: call('gt:tasks'),     // (listId)
  add: call('gt:add'),         // (listId, title)
  done: call('gt:done'),       // (listId, taskId, done)
  remove: call('gt:delete'),   // (listId, taskId)
});
