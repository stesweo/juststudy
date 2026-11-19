// Preload for website views: the mouse side buttons (Back = button 3, Forward = button 4) work like in a normal browser.
const { ipcRenderer } = require('electron');
const side = (e) => {
  if (!e.isTrusted || (e.button !== 3 && e.button !== 4)) return;
  e.preventDefault(); e.stopPropagation();
  if (e.type === 'mouseup') ipcRenderer.send('nav:side', e.button === 3 ? 'back' : 'forward');
};
['mousedown', 'mouseup', 'auxclick'].forEach((t) => window.addEventListener(t, side, true));

/* ---------- ExamSIDE: collapse the empty gaps left where ads were blocked ---------- */
if (/(^|\.)examside\.com$/i.test(location.hostname)) {
  const AD_SRC = /doubleclick|googlesyndication|googleads|adservice|adnxs|taboola|outbrain|amazon-adsystem|\/ads?[\/.?]/i;
  const MEDIA = 'img,svg,canvas,video,audio,input,button,select,textarea,a,picture,[role="button"],[contenteditable]';
  const hidden = new Set();
  const hasText = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) return true;
    return false;
  };
  const isEmpty = (el) => {
    if (el.querySelector(MEDIA)) return false;
    for (const f of el.querySelectorAll('iframe')) {
      const src = f.getAttribute('src') || '';
      if (src && src !== 'about:blank' && !AD_SRC.test(src)) return false; // a real embedded page
    }
    return !hasText(el);
  };
  const css = document.createElement('style');
  css.textContent = 'ins.adsbygoogle,.adsbygoogle,[id^="div-gpt-ad"],[id^="google_ads"],[id*="ad-slot"],[class*="ad-slot"],[class*="adslot"]{display:none!important}';
  const sweep = () => {
    if (!document.body) return;
    for (const el of hidden) { // something real appeared in a collapsed box: bring it back
      if (!el.isConnected || !isEmpty(el)) { el.style.removeProperty('display'); hidden.delete(el); }
    }
    for (const el of document.body.querySelectorAll('div,section,aside,ins,span')) {
      if (hidden.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 80 || r.height > 800 || r.width < 40) continue;
      if (isEmpty(el)) { el.style.setProperty('display', 'none', 'important'); hidden.add(el); }
    }
  };
  let t = null;
  const later = () => { clearTimeout(t); t = setTimeout(sweep, 400); };
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.appendChild(css);
    sweep();
    new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
    setInterval(sweep, 3000);
  });
}
