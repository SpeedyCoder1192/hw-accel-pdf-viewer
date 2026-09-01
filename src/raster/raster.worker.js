// Rasterization worker: one thread that parses *and* rasterizes.
//
// Importing pdf.worker.mjs and hanging it off `globalThis.pdfjsWorker` makes
// pdf.js run its parser inline instead of spawning a nested worker, so each
// instance of this file is exactly one OS thread doing both jobs. Pages are
// drawn into an OffscreenCanvas and handed back as a transferable ImageBitmap,
// which the main thread can hand straight to texImage2D without ever touching
// the pixels itself.

import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
globalThis.pdfjsWorker = pdfjsWorker;

import { getDocument, PasswordResponses } from 'pdfjs-dist';

// Resolved on the main thread and sent with the document: this file is bundled
// into assets/, so its own location is the wrong base for these.
let cMapUrl = new URL('pdfjs/cmaps/', self.location.href).href;
let standardFontDataUrl = new URL('pdfjs/standard_fonts/', self.location.href).href;

// pdf.js's display layer assumes a DOM in several places. In a worker there is
// none, so the two factories it would otherwise reach for are replaced:
//
//   CanvasFactory -- pdf.js creates scratch canvases for transparency groups
//                    and masks via document.createElement.
//   FilterFactory -- SVG filters for soft masks and transfer functions need a
//                    document; "none" is the same fallback pdf.js itself uses
//                    off the main thread, so those effects are skipped rather
//                    than crashing the page.
class OffscreenCanvasFactory {
  #willReadFrequently = true;

  constructor({ enableHWA = false } = {}) {
    this.#willReadFrequently = !enableHWA;
  }

  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: this.#willReadFrequently }) };
  }

  reset(canvasAndContext, width, height) {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

class NullFilterFactory {
  addFilter() {
    return 'none';
  }
  addHCMFilter() {
    return 'none';
  }
  addAlphaFilter() {
    return 'none';
  }
  addLuminosityFilter() {
    return 'none';
  }
  addHighlightHCMFilter() {
    return 'none';
  }
  destroy() {}
}

let doc = null;
const pageCache = new Map(); // pageIndex -> PDFPageProxy
const inFlight = new Map(); // key -> RenderTask

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

async function getPage(pageIndex) {
  let page = pageCache.get(pageIndex);
  if (!page) {
    page = await doc.getPage(pageIndex + 1);
    pageCache.set(pageIndex, page);
  }
  return page;
}

async function open({ id, data, password, assets }) {
  try {
    if (assets?.cMapUrl) cMapUrl = assets.cMapUrl;
    if (assets?.standardFontDataUrl) standardFontDataUrl = assets.standardFontDataUrl;
    if (doc) {
      await doc.destroy().catch(() => {});
      pageCache.clear();
    }
    const task = getDocument({
      data,
      password,
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      isEvalSupported: false,
      // Fetch cmaps and font data from inside the worker. Left to its own
      // devices pdf.js decides this by reading `document.baseURI`, which is a
      // bare reference that throws here; passing a boolean skips that entirely.
      useWorkerFetch: true,
      // No document means no @font-face and no document.fonts, so glyphs are
      // drawn as paths instead. pdf.js only defaults this on under Node.
      disableFontFace: true,
      useSystemFonts: false,
      CanvasFactory: OffscreenCanvasFactory,
      FilterFactory: NullFilterFactory,
    });
    doc = await task.promise;
    post({ type: 'opened', id, numPages: doc.numPages });
  } catch (err) {
    const needsPassword =
      err?.code === PasswordResponses.NEED_PASSWORD ||
      err?.code === PasswordResponses.INCORRECT_PASSWORD;
    post({ type: 'openError', id, message: String(err?.message || err), needsPassword, stack: err?.stack });
  }
}

async function render(job) {
  const { key, pageIndex, rotation, scale, ox, oy, width, height } = job;
  let canvas;
  try {
    if (!doc) throw new Error('no document');
    const page = await getPage(pageIndex);
    if (!inFlight.has(key)) {
      // Cancelled while we were awaiting getPage.
      post({ type: 'cancelled', key });
      return;
    }
    const viewport = page.getViewport({ scale, rotation });
    canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const task = page.render({
      canvasContext: ctx,
      viewport,
      // Shift the page so this tile's slice lands at the canvas origin.
      transform: [1, 0, 0, 1, -ox, -oy],
      intent: 'display',
      background: '#ffffff',
    });
    inFlight.set(key, task);
    await task.promise;
    inFlight.delete(key);

    const bitmap = canvas.transferToImageBitmap();
    post({ type: 'tile', key, bitmap, width, height }, [bitmap]);
  } catch (err) {
    inFlight.delete(key);
    if (err?.name === 'RenderingCancelledException') {
      post({ type: 'cancelled', key });
    } else {
      post({ type: 'renderError', key, message: String(err?.message || err), stack: err?.stack });
    }
  } finally {
    canvas = null;
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'open':
      open(msg);
      break;
    case 'render':
      inFlight.set(msg.key, null); // reserve the slot so cancel() can find it
      render(msg);
      break;
    case 'cancel': {
      const task = inFlight.get(msg.key);
      inFlight.delete(msg.key);
      task?.cancel();
      break;
    }
    case 'close':
      doc?.destroy().catch(() => {});
      doc = null;
      pageCache.clear();
      inFlight.clear();
      break;
    default:
      break;
  }
};
