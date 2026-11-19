// Preload for website views: the mouse side buttons (Back = button 3, Forward = button 4) work like in a normal browser.
const { ipcRenderer } = require('electron');
const side = (e) => {
  if (!e.isTrusted || (e.button !== 3 && e.button !== 4)) return;
  e.preventDefault(); e.stopPropagation();
  if (e.type === 'mouseup') ipcRenderer.send('nav:side', e.button === 3 ? 'back' : 'forward');
};
['mousedown', 'mouseup', 'auxclick'].forEach((t) => window.addEventListener(t, side, true));
