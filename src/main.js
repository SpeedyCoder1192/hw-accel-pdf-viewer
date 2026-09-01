// Bootstrap: wires the chrome to the viewer.
//
// Everything expensive lives behind `Viewer`; this file only translates clicks,
// keys and drops into camera and document commands, and paints the read-only
// bits of UI (page counter, zoom box, find count, stats HUD).

import './styles.css';
import { Viewer } from './viewer.js';
import { Sidebar } from './sidebar.js';
import { SPREAD } from './layout.js';

const $ = (id) => document.getElementById(id);

const el = {
  stage: $('stage'),
  canvas: $('gl'),
  overlay: $('overlay'),
  dropHint: $('dropHint'),
  hud: $('hud'),
  progress: $('progress'),
  progressBar: $('progress').firstElementChild,
  toast: $('toast'),
  title: $('docTitle'),

  btnSidebar: $('btnSidebar'),
  btnOpen: $('btnOpen'),
  btnPrev: $('btnPrev'),
  btnNext: $('btnNext'),
  pageInput: $('pageInput'),
  pageCount: $('pageCount'),
  btnZoomIn: $('btnZoomIn'),
  btnZoomOut: $('btnZoomOut'),
  zoomSelect: $('zoomSelect'),
  btnPan: $('btnPan'),
  btnFind: $('btnFind'),
  btnDark: $('btnDark'),
  btnMenu: $('btnMenu'),
  menu: $('menu'),

  sidebar: $('sidebar'),
  thumbs: $('thumbs'),
  outline: $('outline'),
  tabThumbs: $('tabThumbs'),
  tabOutline: $('tabOutline'),

  findbar: $('findbar'),
  findInput: $('findInput'),
  findCount: $('findCount'),
  findPrev: $('findPrev'),
  findNext: $('findNext'),
  findCase: $('findCase'),
  findWord: $('findWord'),
  findClose: $('findClose'),

  fileInput: $('fileInput'),
  pickFile: $('pickFile'),
  hintPick: $('hintPick'),
  hintNote: $('hintNote'),
  hintUrl: $('hintUrl'),
  hintActions: $('hintActions'),
  hintRetry: $('hintRetry'),
  hintCopy: $('hintCopy'),
  passwordDialog: $('passwordDialog'),
  passwordInput: $('passwordInput'),
  passwordMsg: $('passwordMsg'),
  propsDialog: $('propsDialog'),
  propsList: $('propsList'),
  helpDialog: $('helpDialog'),
};

const ui = {
  hasDoc: false,
  hudOn: false,
  presentation: false,
  takeover: true,
  sourceUrl: '',
  lastState: {},
};

// The same page runs as an extension tab and as a plain web page (vite dev);
// only the extension has chrome.runtime and the PDF-takeover switch.
const isExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
const STORE_KEY = 'takeover';

if (isExtension) {
  $('hintExt').hidden = false;
  $('menu').querySelector('[data-act="takeover"]').hidden = false;
  chrome.storage.sync.get(STORE_KEY).then(({ [STORE_KEY]: on = true }) => {
    ui.takeover = on;
  });
}

// ------------------------------------------------------------------- viewer

const viewer = new Viewer({
  canvas: el.canvas,
  overlayRoot: el.overlay,
  stage: el.stage,
  onState: (s) => onState(s),
  onError: (err) => {
    console.error(err);
    toast(err.message || String(err));
  },
});

viewer.renderer.onContextLost = () => {
  toast('The GPU context was lost. Reload the page to continue.');
};

const sidebar = new Sidebar({
  root: el.sidebar,
  thumbsEl: el.thumbs,
  outlineEl: el.outline,
  tabThumbs: el.tabThumbs,
  tabOutline: el.tabOutline,
  viewer: () => viewer,
  onGoto: (i) => viewer.goToPage(i),
  onDestination: (dest) => viewer.goToDestination(dest),
});

// ------------------------------------------------------------------ loading

async function openSource(source, opts = {}) {
  showProgress(0.25);
  ui.sourceUrl = '';
  ui.sourceHash = '';
  let input = source;
  if (typeof source === 'string') {
    // A URL load must never quietly degrade into the file picker: say what is
    // happening, and if it fails, say why and offer the retry.
    setHint({ busy: `Opening ${nameFromUrl(source)}…`, url: source });
    try {
      input = await fetchBytes(source);
    } catch (err) {
      hideProgress();
      setHint({ error: err.message, url: source, retry: () => openSource(source, opts) });
      toast(err.message, 5000);
      return;
    }
    opts = { filename: nameFromUrl(source), ...opts };
    ui.sourceUrl = source;
    ui.sourceHash = source.includes('#') ? source.slice(source.indexOf('#') + 1) : '';
  }

  let password = opts.password;
  for (;;) {
    try {
      await viewer.load(input, { ...opts, password });
      break;
    } catch (err) {
      if (err?.name === 'PasswordException' || err?.needsPassword) {
        const retry = err.code === 2 || /incorrect/i.test(err.message || '');
        password = await askPassword(retry);
        if (password === null) {
          hideProgress();
          return;
        }
        continue;
      }
      hideProgress();
      console.error(err);
      const message = `Could not open the document: ${err?.message || err}`;
      setHint({
        error: message,
        url: ui.sourceUrl,
        retry: ui.sourceUrl ? () => openSource(ui.sourceUrl, opts) : null,
      });
      toast(message, 5000);
      return;
    }
  }

  ui.hasDoc = true;
  setHint();
  el.dropHint.hidden = true;
  focusStage();
  el.title.title = ui.sourceUrl || '';
  sidebar.setDocument(viewer);
  sidebar.setPage(viewer.currentPage);
  document.title = `${viewer.meta?.info?.Title || viewer.filename} — PDF Viewer`;
  applyHash(ui.sourceHash);
  showProgress(1);
  setTimeout(hideProgress, 250);
}

/** doc.pdf#page=12&zoom=150 — the fragment survives the extension's redirect. */
function applyHash(hash) {
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const page = parseInt(params.get('page'), 10);
  const dest = params.get('nameddest');
  const zoom = parseFloat(params.get('zoom'));
  if (Number.isFinite(zoom) && zoom > 0) viewer.setZoom(zoom / 100, null, true);
  if (Number.isFinite(page)) viewer.goToPage(page - 1, { immediate: true });
  else if (dest) viewer.goToDestination(dest);
}

function askPassword(retry) {
  return new Promise((resolve) => {
    el.passwordMsg.textContent = retry
      ? 'That password was not accepted. Try again.'
      : 'This document is encrypted. Enter its password to open it.';
    el.passwordInput.value = '';
    el.passwordDialog.showModal();
    el.passwordInput.focus();
    el.passwordDialog.addEventListener(
      'close',
      () => resolve(el.passwordDialog.returnValue === 'ok' ? el.passwordInput.value : null),
      { once: true }
    );
  });
}

function openFile(file) {
  if (!file) return;
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    toast('That does not look like a PDF.');
    return;
  }
  openSource(file, { filename: file.name });
}

el.fileInput.addEventListener('change', () => {
  openFile(el.fileInput.files?.[0]);
  el.fileInput.value = '';
});
el.btnOpen.addEventListener('click', () => el.fileInput.click());
el.pickFile.addEventListener('click', () => el.fileInput.click());

// Drag & drop, anywhere over the stage.
let dragDepth = 0;
for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (type === 'dragenter') dragDepth++;
    el.stage.classList.add('dragover');
  });
}
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.stage.classList.remove('dragover');
  }
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  el.stage.classList.remove('dragover');
  openFile(e.dataTransfer.files?.[0]);
});

// Paste a URL to a PDF.
window.addEventListener('paste', (e) => {
  if (isTyping(document.activeElement)) return;
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) {
    openFile(file);
    return;
  }
  const text = e.clipboardData?.getData('text')?.trim();
  if (text && /^https?:\/\/\S+$/i.test(text)) openSource(text);
});

// -------------------------------------------------------- fetching by URL

function nameFromUrl(url) {
  const bare = url.split(/[?#]/)[0];
  try {
    return decodeURIComponent(bare.split('/').pop()) || 'document.pdf';
  } catch {
    return bare.split('/').pop() || 'document.pdf';
  }
}

async function fetchBytes(url) {
  const local = /^file:/i.test(url);
  if (!local) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.arrayBuffer();
    } catch (err) {
      throw new Error(`Could not fetch ${url} — ${err.message}`);
    }
  }
  // fetch() refuses file:// URLs; XHR still works, but only once the user has
  // ticked "Allow access to file URLs" on the extension's details page.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () =>
      xhr.response
        ? resolve(xhr.response)
        : reject(new Error('The local file could not be read.'));
    xhr.onerror = () =>
      reject(
        new Error(
          isExtension
            ? 'Local file blocked. Enable "Allow access to file URLs" for this extension in chrome://extensions.'
            : 'Local file blocked by the browser.'
        )
      );
    xhr.send();
  });
}

// ?file=<url>. The extension's redirect rule cannot percent-encode its
// substitution, so the parameter is taken as the raw tail of the query rather
// than parsed -- a PDF URL with its own ?query would otherwise be truncated.
function fileParam() {
  const marker = location.href.indexOf('?file=');
  if (marker === -1) return null;
  const raw = location.href.slice(marker + 6);
  if (!raw) return null;
  if (/^(?:https?|file):\/\//i.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Where the document comes from when the page opens: the redirect's ?file=
 * parameter, or — if that handoff was lost — the URL the service worker
 * recorded for this tab. Without the second path, a lost parameter looks like
 * an empty viewer, which is the wrong thing to show someone who clicked a PDF.
 */
async function resolveInitialFile() {
  const param = fileParam();
  if (param) return param;
  if (!isExtension) return null;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'pendingUrl' });
    return res?.url || null;
  } catch {
    return null; // service worker asleep or restarted
  }
}

resolveInitialFile().then((url) => {
  if (url) openSource(url);
});

// --------------------------------------------------------- drop-hint states

function setHint({ busy, error, url, retry } = {}) {
  if (ui.hasDoc) return; // a failed second load must not cover the document
  const active = Boolean(busy || error);
  el.hintPick.hidden = active;
  el.hintNote.hidden = !active;
  el.hintNote.textContent = error || busy || '';
  el.hintNote.classList.toggle('error', Boolean(error));
  el.hintUrl.hidden = !url;
  el.hintUrl.textContent = url || '';
  el.hintActions.hidden = !error;
  el.hintCopy.hidden = !url;
  ui.retry = retry || null;
  ui.hintUrl = url || '';
}

el.hintRetry.addEventListener('click', () => ui.retry?.());
el.hintCopy.addEventListener('click', () => {
  if (!ui.hintUrl) return;
  navigator.clipboard.writeText(ui.hintUrl).then(
    () => toast('Link copied.'),
    () => toast('Could not copy the link.')
  );
});

// --------------------------------------------------------------- toolbar UI

el.btnSidebar.addEventListener('click', () => toggleSidebar());
el.btnPrev.addEventListener('click', () => viewer.stepPage(-1));
el.btnNext.addEventListener('click', () => viewer.stepPage(1));
el.btnZoomIn.addEventListener('click', () => viewer.zoomBy(1.25));
el.btnZoomOut.addEventListener('click', () => viewer.zoomBy(1 / 1.25));

el.pageInput.addEventListener('change', () => {
  const n = parseInt(el.pageInput.value, 10);
  if (Number.isFinite(n)) viewer.goToPage(n - 1);
  else el.pageInput.value = String(viewer.currentPage + 1);
});
el.pageInput.addEventListener('focus', () => el.pageInput.select());
el.pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') focusStage();
  else if (e.key === 'Escape') focusStage();
});

el.zoomSelect.addEventListener('change', () => {
  const v = el.zoomSelect.value;
  if (v === 'width' || v === 'page' || v === 'height' || v === 'actual') viewer.setFit(v);
  else if (v !== 'custom') viewer.setZoom(parseFloat(v));
  focusStage();
});

el.btnPan.addEventListener('click', () => viewer.setTool(viewer.tool === 'pan' ? 'select' : 'pan'));
el.btnDark.addEventListener('click', () => setDark(!viewer.dark));
el.btnFind.addEventListener('click', () => toggleFind());

// Overflow menu.
el.btnMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = el.menu.hidden;
  el.menu.hidden = !open;
  el.btnMenu.setAttribute('aria-expanded', String(open));
  if (open) syncMenu();
});
document.addEventListener('click', () => {
  if (!el.menu.hidden) {
    el.menu.hidden = true;
    el.btnMenu.setAttribute('aria-expanded', 'false');
  }
});
el.menu.addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (act) runAction(act);
});

function syncMenu() {
  const mark = (act, on) => el.menu.querySelector(`[data-act="${act}"]`)?.classList.toggle('on', on);
  mark('spread-none', viewer.spread === SPREAD.NONE);
  mark('spread-book', viewer.spread === SPREAD.BOOK);
  mark('spread-two', viewer.spread === SPREAD.TWO_UP);
  mark('hud', ui.hudOn);
  mark('takeover', ui.takeover);
}

function runAction(act) {
  switch (act) {
    case 'rotate-cw':
      viewer.rotate(90);
      sidebar.invalidate(viewer);
      break;
    case 'rotate-ccw':
      viewer.rotate(-90);
      sidebar.invalidate(viewer);
      break;
    case 'spread-none':
      viewer.setSpread(SPREAD.NONE);
      sidebar.invalidate(viewer);
      break;
    case 'spread-book':
      viewer.setSpread(SPREAD.BOOK);
      sidebar.invalidate(viewer);
      break;
    case 'spread-two':
      viewer.setSpread(SPREAD.TWO_UP);
      sidebar.invalidate(viewer);
      break;
    case 'presentation':
      setPresentation(!ui.presentation);
      break;
    case 'fullscreen':
      toggleFullscreen();
      break;
    case 'print':
      doPrint();
      break;
    case 'download':
      if (requireDoc()) viewer.download();
      break;
    case 'hud':
      setHud(!ui.hudOn);
      break;
    case 'takeover':
      setTakeover(!ui.takeover);
      break;
    case 'properties':
      showProperties();
      break;
    case 'help':
      el.helpDialog.showModal();
      break;
    default:
      break;
  }
}

function requireDoc() {
  if (!ui.hasDoc) {
    toast('Open a document first.');
    return false;
  }
  return true;
}

function toggleSidebar(force) {
  if (!ui.hasDoc && force !== false) {
    if (!requireDoc()) return;
  }
  const on = sidebar.toggle(force);
  el.btnSidebar.setAttribute('aria-pressed', String(on));
}

function setDark(on) {
  viewer.setDark(on);
  document.body.classList.toggle('dark', on);
  el.btnDark.setAttribute('aria-pressed', String(on));
  localStorage.setItem('pdfviewer.dark', on ? '1' : '0');
}

function setTakeover(on) {
  if (!isExtension) return;
  ui.takeover = on;
  // The service worker watches this key and adds or drops its redirect rules.
  chrome.storage.sync.set({ [STORE_KEY]: on });
  toast(on ? 'PDF links will open in this viewer.' : "PDF links will use the browser's viewer.");
}

function setHud(on) {
  ui.hudOn = on;
  el.hud.hidden = !on;
  if (on) tickHud();
}

function tickHud() {
  if (!ui.hudOn) return;
  const s = viewer.stats;
  el.hud.innerHTML =
    `<b>${s.fps.toFixed(0).padStart(3)}</b> fps   <b>${s.drawCalls}</b> draws\n` +
    `tex <b>${s.textures}</b>  vram <b>${(s.vram / 1048576).toFixed(1)}</b> MB\n` +
    `queue <b>${s.pending}</b>  workers <b>${s.workers}</b>\n` +
    `up ${s.uploads}  evict ${s.evictions}\n` +
    `${escapeHtml(s.adapter).slice(0, 46)}`;
  requestAnimationFrame(tickHud);
}

function showProperties() {
  if (!requireDoc()) return;
  const info = viewer.meta?.info || {};
  const rows = [
    ['File name', viewer.filename],
    ['Title', info.Title],
    ['Author', info.Author],
    ['Subject', info.Subject],
    ['Keywords', info.Keywords],
    ['Creator', info.Creator],
    ['Producer', info.Producer],
    ['Created', formatPdfDate(info.CreationDate)],
    ['Modified', formatPdfDate(info.ModDate)],
    ['PDF version', info.PDFFormatVersion],
    ['Pages', String(viewer.numPages)],
    ['Page size', pageSizeLabel()],
    ['Size', `${(viewer.bytes.byteLength / 1048576).toFixed(2)} MB`],
  ];
  el.propsList.replaceChildren();
  for (const [k, v] of rows) {
    if (!v) continue;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    el.propsList.append(dt, dd);
  }
  el.propsDialog.showModal();
}

function pageSizeLabel() {
  const p = viewer.baseSizes[viewer.currentPage];
  if (!p) return '';
  const mm = (pt) => (pt * 25.4) / 72;
  const inch = (pt) => pt / 72;
  return `${mm(p.w).toFixed(0)} × ${mm(p.h).toFixed(0)} mm  (${inch(p.w).toFixed(2)} × ${inch(p.h).toFixed(2)} in)`;
}

function formatPdfDate(raw) {
  // D:YYYYMMDDHHmmSS...
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw || '');
  if (!m) return raw || '';
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString();
}

async function doPrint() {
  if (!requireDoc()) return;
  toast('Rendering pages for print…', 0);
  showProgress(0.02);
  try {
    await viewer.print((done, total) => {
      showProgress(done / total);
      toast(`Rendering pages for print… ${done}/${total}`, 0);
    });
    toast('Sent to the print dialog.');
  } catch (err) {
    toast(`Print failed: ${err.message}`);
  } finally {
    hideProgress();
  }
}

// ------------------------------------------------------------ presentation

function setPresentation(on) {
  if (on && !requireDoc()) return;
  ui.presentation = on;
  viewer.presentation = on;
  document.body.classList.toggle('presentation', on);
  if (on) {
    toggleSidebar(false);
    document.documentElement.requestFullscreen?.().catch(() => {});
    ui.spreadBefore = viewer.spread;
    viewer.setSpread(SPREAD.NONE);
    viewer.setFit('page');
  } else {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    viewer.setSpread(ui.spreadBefore ?? SPREAD.NONE);
    viewer.setFit('width');
  }
  sidebar.invalidate(viewer);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && ui.presentation) setPresentation(false);
});

// -------------------------------------------------------------------- find

function toggleFind(force) {
  const show = force ?? el.findbar.hidden;
  if (show && !requireDoc()) return;
  el.findbar.hidden = !show;
  if (show) {
    el.findInput.focus();
    el.findInput.select();
  } else {
    viewer.finder.reset();
    el.findCount.textContent = '';
    el.findInput.classList.remove('notfound');
    focusStage();
  }
}

let findTimer = 0;
function scheduleFind() {
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 140);
}

function runFind() {
  viewer.find(el.findInput.value, {
    caseSensitive: el.findCase.checked,
    wholeWord: el.findWord.checked,
  });
}

el.findInput.addEventListener('input', scheduleFind);
el.findCase.addEventListener('change', runFind);
el.findWord.addEventListener('change', runFind);
el.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    viewer.findStep(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    toggleFind(false);
  }
});
el.findNext.addEventListener('click', () => viewer.findStep(1));
el.findPrev.addEventListener('click', () => viewer.findStep(-1));
el.findClose.addEventListener('click', () => toggleFind(false));

// ------------------------------------------------------------- state paint

function onState(s) {
  if (s.find) {
    const f = s.find;
    el.findCount.textContent = !f.query
      ? ''
      : f.total === 0
        ? f.scanning
          ? 'searching…'
          : 'no matches'
        : `${f.current + 1} of ${f.total}${f.scanning ? '…' : ''}`;
    el.findInput.classList.toggle('notfound', Boolean(f.query) && !f.scanning && f.total === 0);
    return;
  }

  Object.assign(ui.lastState, s);
  const has = s.numPages > 0;
  if (document.activeElement !== el.pageInput) el.pageInput.value = has ? String(s.page + 1) : '0';
  el.pageCount.textContent = String(s.numPages);
  el.btnPrev.disabled = !has || s.page <= 0;
  el.btnNext.disabled = !has || s.page >= s.numPages - 1;
  el.title.textContent = !has ? 'No document' : s.title ? `${s.title} — ${s.filename}` : s.filename;
  el.btnPan.setAttribute('aria-pressed', String(s.tool === 'pan'));

  if (s.fit === 'width' || s.fit === 'page' || s.fit === 'height' || s.fit === 'actual') {
    el.zoomSelect.value = s.fit;
  } else {
    const pct = `${Math.round(s.zoom * 100)}%`;
    const exact = [...el.zoomSelect.options].find(
      (o) => o.value !== 'custom' && Math.abs(parseFloat(o.value) - s.zoom) < 0.005
    );
    if (exact) {
      el.zoomSelect.value = exact.value;
    } else {
      const custom = el.zoomSelect.querySelector('option[value="custom"]');
      custom.textContent = pct;
      custom.hidden = false;
      el.zoomSelect.value = 'custom';
    }
  }

  sidebar.setPage(s.page);
}

// ---------------------------------------------------------------- keyboard

const isTyping = (node) =>
  node instanceof HTMLElement &&
  (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable);

let spaceAt = 0;

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;

  if (mod) {
    switch (e.key.toLowerCase()) {
      case 'f':
        e.preventDefault();
        toggleFind(true);
        return;
      case 'o':
        e.preventDefault();
        el.fileInput.click();
        return;
      case 'p':
        e.preventDefault();
        doPrint();
        return;
      case 's':
        e.preventDefault();
        if (requireDoc()) viewer.download();
        return;
      case '=':
      case '+':
        e.preventDefault();
        viewer.zoomBy(1.25);
        return;
      case '-':
        e.preventDefault();
        viewer.zoomBy(1 / 1.25);
        return;
      case '0':
        e.preventDefault();
        viewer.setFit('width');
        return;
      default:
        return;
    }
  }

  if (isTyping(e.target) || document.querySelector('dialog[open]')) {
    if (e.key === 'Escape' && !el.findbar.hidden && e.target === el.findInput) toggleFind(false);
    return;
  }

  const step = 60;
  switch (e.key) {
    case 'ArrowDown':
      viewer.scrollBy(0, step);
      break;
    case 'ArrowUp':
      viewer.scrollBy(0, -step);
      break;
    case 'ArrowRight':
      if (ui.presentation) viewer.stepPage(1);
      else viewer.scrollBy(step, 0);
      break;
    case 'ArrowLeft':
      if (ui.presentation) viewer.stepPage(-1);
      else viewer.scrollBy(-step, 0);
      break;
    case 'PageDown':
      viewer.stepPage(1);
      break;
    case 'PageUp':
      viewer.stepPage(-1);
      break;
    case 'Home':
      viewer.goToPage(0);
      break;
    case 'End':
      viewer.goToPage(viewer.numPages - 1);
      break;
    case ' ':
      // Held space pans (viewer reads `spaceDown`); a short tap pages down.
      viewer.spaceDown = true;
      if (!spaceAt) spaceAt = performance.now();
      break;
    case '+':
    case '=':
      viewer.zoomBy(1.25);
      break;
    case '-':
    case '_':
      viewer.zoomBy(1 / 1.25);
      break;
    case '0':
      viewer.setFit('actual');
      break;
    case '1':
      viewer.setFit('width');
      break;
    case '2':
      viewer.setFit('page');
      break;
    case '3':
      viewer.setFit('height');
      break;
    case 'Escape':
      if (ui.presentation) setPresentation(false);
      else if (!el.findbar.hidden) toggleFind(false);
      else focusStage();
      break;
    case 'F3':
      viewer.findStep(e.shiftKey ? -1 : 1);
      break;
    case '?':
      el.helpDialog.showModal();
      break;
    case '/':
      toggleFind(true);
      break;
    default: {
      const k = e.key.toLowerCase();
      const half = viewer.viewport.h * 0.5;
      if (k === 'r') {
        viewer.rotate(e.shiftKey ? -90 : 90);
        sidebar.invalidate(viewer);
      } else if (k === 'j') viewer.scrollBy(0, step);
      else if (k === 'k') viewer.scrollBy(0, -step);
      else if (k === 'd' && !e.shiftKey) viewer.scrollBy(0, half);
      else if (k === 'u') viewer.scrollBy(0, -half);
      else if (k === 'd' && e.shiftKey) setDark(!viewer.dark);
      else if (k === 'g') {
        if (e.shiftKey) viewer.goToPage(viewer.numPages - 1);
        else if (ui.hasDoc) {
          // Go to page: hand the keyboard the page box rather than a prompt.
          el.pageInput.focus();
          el.pageInput.select();
        }
      } else if (k === 'n') viewer.findStep(e.shiftKey ? -1 : 1);
      else if (k === 's') toggleSidebar();
      else if (k === 'h') viewer.setTool(viewer.tool === 'pan' ? 'select' : 'pan');
      else if (k === 'p') setPresentation(!ui.presentation);
      else if (k === 'i' && e.shiftKey) setHud(!ui.hudOn);
      else return;
      break;
    }
  }
  e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  if (e.key !== ' ') return;
  viewer.spaceDown = false;
  const held = spaceAt ? performance.now() - spaceAt : 0;
  spaceAt = 0;
  if (held < 250 && !isTyping(e.target) && ui.hasDoc) {
    viewer.scrollBy(0, viewer.viewport.h * 0.9 * (e.shiftKey ? -1 : 1));
  }
});

window.addEventListener('blur', () => {
  viewer.spaceDown = false;
  spaceAt = 0;
});

// ------------------------------------------------------------------ chrome

let toastTimer = 0;
function toast(message, ms = 2600) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}

function focusStage() {
  el.stage.focus({ preventScroll: true });
}

function showProgress(fraction) {
  el.progress.hidden = false;
  el.progressBar.style.width = `${Math.round(fraction * 100)}%`;
}

function hideProgress() {
  el.progress.hidden = true;
  el.progressBar.style.width = '0%';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

// Restore the one preference worth persisting.
if (localStorage.getItem('pdfviewer.dark') === '1') setDark(true);
else if (localStorage.getItem('pdfviewer.dark') === null && matchMedia('(prefers-color-scheme: dark)').matches) {
  setDark(true);
}

// Handy for poking at the engine from the console.
window.viewer = viewer;
