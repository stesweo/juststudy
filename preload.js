// Exposes a small, fixed Google Tasks bridge to the page (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('gtasks', {
  status: call('gt:status'),         // -> { configured, signedIn }
  signIn: call('gt:signIn'),         // (mode: 'app' | 'browser')
  signOut: call('gt:signOut'),
  lists: call('gt:lists'),
  createList: call('gt:createList'), // (title)
  renameList: call('gt:renameList'), // (listId, title)
  deleteList: call('gt:deleteList'), // (listId)
  clearDone: call('gt:clearDone'),   // (listId)
  tasks: call('gt:tasks'),           // (listId)
  add: call('gt:add'),               // (listId, { title, notes, due }, { parent, previous })
  update: call('gt:update'),         // (listId, taskId, { title, notes, due })
  done: call('gt:done'),             // (listId, taskId, done)
  remove: call('gt:delete'),         // (listId, taskId)
  move: call('gt:move'),             // (listId, taskId, { parent, previous })
  moveToList: call('gt:moveList'),   // (fromListId, taskId, toListId) -> { oldId: newId }
});
