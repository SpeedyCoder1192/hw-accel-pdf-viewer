// The viewer: camera, tile scheduling, and the frame loop.
//
// The central idea is that the camera is cheap and rasterization is expensive,
// so they are decoupled. A gesture only ever moves the camera; the frame it
// produces is composited from whatever textures happen to be resident, coarse
// ones standing in for fine ones until the workers catch up. Nothing in the
// input path ever waits on a rasterizer.

import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { Renderer } from './gl/renderer.js';
import { TileCache } from './gl/tilecache.js';
import { RasterPool, isCancelled } from './raster/pool.js';
import { computeLayout, pageAtViewport, visiblePages, SPREAD, PAGE_GAP } from './layout.js';
import { OverlayManager } from './textlayer.js';
import { Finder } from './search.js';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Resolved against the page, not against a bundled worker's own path, and
// handed to the raster workers so both parses agree on where the assets live.
const PDF_ASSETS = {
  cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href,
  standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
};

const TILE = 512; // device pixels
const LOD_STEPS = 2; // quantization steps per octave; 2 = half-octave
const LOD_FALLBACKS = 4; // coarser levels painted underneath while tiles load
const PREVIEW_MAX_PX = 1024;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 12;
const MAX_RASTER_SCALE = 16;
const PAD = 20; // doc-space padding used by fit modes
const PREFETCH_MARGIN = 0.75; // fraction of a viewport of look-ahead
const EASE_RATE = 26;

const THEMES = {
  light: { bg: [0.878, 0.886, 0.902], shadow: [0, 0, 0, 0.28] },
  dark: { bg: [0.086, 0.094, 0.11], shadow: [0, 0, 0, 0.55] },
};

export class Viewer {
  // A private method cannot be rebound, so the frame callback is a field that
  // closes over `this` instead.
  #tick = (now) => this.#loop(now);

  constructor({ canvas, overlayRoot, stage, onState, onError }) {
    this.canvas = canvas;
    this.stage = stage;
    this.onState = onState || (() => {});
    this.onError = onError || ((e) => console.error(e));

    this.renderer = new Renderer(canvas);
    this.cache = new TileCache(this.renderer);
    this.pool = new RasterPool();

    this.doc = null;
    this.bytes = null;
    this.filename = 'document.pdf';
    this.numPages = 0;
    this.pageSizes = [];
    this.baseSizes = [];
    this.layout = { pages: [], rows: [], width: 0, height: 0 };

    this.rotation = 0;
    this.spread = SPREAD.NONE;
    this.fit = 'width';
    this.dark = false;
    this.tool = 'select';
    this.presentation = false;

    this.cam = { x: 0, y: 0, zoom: 1 };
    this.target = { x: 0, y: 0, zoom: 1 };
    this.viewport = { w: 1, h: 1 };
    this.dpr = window.devicePixelRatio || 1;

    this.currentPage = 0;
    this.needsFrame = true;
    this.running = false;
    this.lastTime = 0;
    this.fps = 0;
    this.pendingReveal = null;
    this.spaceDown = false;

    this.textCache = new Map();
    this.annotCache = new Map();
    this.pageCache = new Map();

    this.overlay = new OverlayManager(overlayRoot, {
      getPage: (i) => this.getPage(i),
      getTextContent: (i) => this.getTextContent(i),
      getAnnotations: (i) => this.getAnnotations(i),
      getRotation: () => this.rotation,
      onInternalLink: (dest) => this.goToDestination(dest),
    });

    this.finder = new Finder({
      numPages: 0,
      getTextContent: (i) => this.getTextContent(i),
      onUpdate: (s) => this.#onFindUpdate(s),
    });

    this.scrollbars = { v: null, h: null, drag: null };

    this.#installObservers();
    this.#installInput();
    this.running = true;
    requestAnimationFrame(this.#tick);
  }

  // ---------------------------------------------------------------- loading

  async load(source, { password, filename } = {}) {
    let data;
    if (source instanceof ArrayBuffer) data = source;
    else if (source instanceof Uint8Array) data = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    else if (source instanceof Blob) data = await source.arrayBuffer();
    else if (typeof source === 'string') {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
      data = await res.arrayBuffer();
      this.filename = decodeURIComponent(source.split('/').pop().split('?')[0] || 'document.pdf');
    }
    if (filename) this.filename = filename;
    if (!data) throw new Error('unsupported source');

    this.#teardownDoc();
    this.bytes = data;

    // The main-thread document owns structure (text, outline, links); the pool
    // owns pixels. They are separate parses of the same bytes on purpose.
    const task = pdfjs.getDocument({
      data: data.slice(0),
      password,
      cMapUrl: PDF_ASSETS.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: PDF_ASSETS.standardFontDataUrl,
      isEvalSupported: false,
    });
    this.doc = await task.promise;
    this.numPages = this.doc.numPages;
    await this.pool.open(data, password, PDF_ASSETS);

    this.finder = new Finder({
      numPages: this.numPages,
      getTextContent: (i) => this.getTextContent(i),
      onUpdate: (s) => this.#onFindUpdate(s),
    });

    const first = await this.getPage(0);
    const v0 = first.getViewport({ scale: 1, rotation: 0 });
    // Assume a uniform page size so the first frame is instant, then correct
    // the outliers in the background. Most PDFs never need the correction.
    this.baseSizes = new Array(this.numPages).fill(null).map(() => ({ w: v0.width, h: v0.height }));
    this.baseSizes[0] = { w: v0.width, h: v0.height };
    this.#relayout();
    this.currentPage = 0;
    this.setFit('width', true);
    this.#snapCamera();
    this.#loadRealPageSizes();

    this.meta = await this.doc.getMetadata().catch(() => null);
    this.outline = await this.doc.getOutline().catch(() => null);
    this.emit();
    this.requestFrame();
    return this.doc;
  }

  async #loadRealPageSizes() {
    const token = (this.sizeToken = Symbol('sizes'));
    const CONCURRENCY = 12;
    let cursor = 1;
    let changed = false;
    const worker = async () => {
      while (cursor < this.numPages) {
        const i = cursor++;
        if (token !== this.sizeToken) return;
        try {
          const page = await this.getPage(i);
          const v = page.getViewport({ scale: 1, rotation: 0 });
          if (Math.abs(v.width - this.baseSizes[i].w) > 0.5 || Math.abs(v.height - this.baseSizes[i].h) > 0.5) {
            this.baseSizes[i] = { w: v.width, h: v.height };
            changed = true;
          }
        } catch {
          /* keep the assumed size */
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (token !== this.sizeToken || !changed) return;
    this.#relayoutPreservingPosition();
  }

  #teardownDoc() {
    this.sizeToken = null;
    this.cache.clear();
    this.pool.clear();
    this.overlay.reset();
    this.textCache.clear();
    this.annotCache.clear();
    this.pageCache.clear();
    this.doc?.destroy().catch(() => {});
    this.doc = null;
    this.outline = null;
    this.meta = null;
  }

  getPage(i) {
    let p = this.pageCache.get(i);
    if (!p) {
      p = this.doc.getPage(i + 1);
      this.pageCache.set(i, p);
    }
    return p;
  }

  getTextContent(i) {
    let t = this.textCache.get(i);
    if (!t) {
      t = this.getPage(i).then((page) => page.getTextContent());
      this.textCache.set(i, t);
    }
    return t;
  }

  getAnnotations(i) {
    let a = this.annotCache.get(i);
    if (!a) {
      a = this.getPage(i)
        .then((page) => page.getAnnotations({ intent: 'display' }))
        .catch(() => []);
      this.annotCache.set(i, a);
    }
    return a;
  }

  // ----------------------------------------------------------------- layout

  #rotatedSizes() {
    const swap = this.rotation % 180 !== 0;
    return this.baseSizes.map(({ w, h }) => (swap ? { w: h, h: w } : { w, h }));
  }

  #relayout() {
    this.pageSizes = this.#rotatedSizes();
    this.layout = computeLayout(this.pageSizes, { spread: this.spread, gap: PAGE_GAP });
    this.#clampTarget();
    this.requestFrame();
  }

  /** Relayout without the page under the user jumping around. */
  #relayoutPreservingPosition() {
    const page = this.layout.pages[this.currentPage];
    const offX = page ? (this.target.x - page.x) / (page.w || 1) : 0;
    const offY = page ? (this.target.y - page.y) / (page.h || 1) : 0;
    this.#relayout();
    const np = this.layout.pages[this.currentPage];
    if (np) {
      this.target.x = np.x + offX * np.w;
      this.target.y = np.y + offY * np.h;
      this.#clampTarget();
      this.#snapCamera();
    }
    this.overlay.reset();
    this.emit();
  }

  setRotation(deg) {
    this.rotation = ((deg % 360) + 360) % 360;
    // Tile keys embed the rotation, so old textures are simply unreachable;
    // drop them rather than paying VRAM for an orientation nobody is viewing.
    this.cache.clear();
    this.pool.clear();
    this.overlay.reset();
    this.#relayoutPreservingPosition();
    if (this.fit !== 'none') this.setFit(this.fit, true);
  }

  rotate(delta) {
    this.setRotation(this.rotation + delta);
  }

  setSpread(mode) {
    this.spread = mode;
    this.#relayoutPreservingPosition();
    if (this.fit !== 'none') this.setFit(this.fit, true);
  }

  // ----------------------------------------------------------------- camera

  get viewRect() {
    return {
      x: this.cam.x - this.viewport.w / (2 * this.cam.zoom),
      y: this.cam.y - this.viewport.h / (2 * this.cam.zoom),
      w: this.viewport.w / this.cam.zoom,
      h: this.viewport.h / this.cam.zoom,
    };
  }

  get targetRect() {
    return {
      x: this.target.x - this.viewport.w / (2 * this.target.zoom),
      y: this.target.y - this.viewport.h / (2 * this.target.zoom),
      w: this.viewport.w / this.target.zoom,
      h: this.viewport.h / this.target.zoom,
    };
  }

  #clampTarget() {
    const t = this.target;
    t.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.zoom));
    const visW = this.viewport.w / t.zoom;
    const visH = this.viewport.h / t.zoom;
    const docW = this.layout.width;
    const docH = this.layout.height;
    t.x = visW >= docW ? docW / 2 : clamp(t.x, visW / 2, docW - visW / 2);
    t.y = visH >= docH ? docH / 2 : clamp(t.y, visH / 2, docH - visH / 2);
  }

  #snapCamera() {
    this.cam.x = this.target.x;
    this.cam.y = this.target.y;
    this.cam.zoom = this.target.zoom;
    this.requestFrame();
  }

  setZoom(zoom, anchor, immediate = false) {
    const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (anchor) {
      // Keep the doc point under the cursor pinned while the scale changes.
      const t = this.target;
      const dx = (anchor.x - this.viewport.w / 2) / t.zoom;
      const dy = (anchor.y - this.viewport.h / 2) / t.zoom;
      const docX = t.x + dx;
      const docY = t.y + dy;
      t.zoom = z;
      t.x = docX - (anchor.x - this.viewport.w / 2) / z;
      t.y = docY - (anchor.y - this.viewport.h / 2) / z;
    } else {
      this.target.zoom = z;
    }
    this.fit = 'none';
    this.#clampTarget();
    if (immediate) this.#snapCamera();
    this.requestFrame();
    this.emit();
  }

  zoomBy(factor, anchor) {
    this.setZoom(this.target.zoom * factor, anchor);
  }

  setFit(mode, silent = false) {
    this.fit = mode;
    const page = this.layout.pages[this.currentPage];
    if (!page) return;
    if (mode === 'width') {
      this.target.zoom = clamp(this.viewport.w / (this.layout.width + PAD * 2), MIN_ZOOM, MAX_ZOOM);
      const row = this.layout.rows[page.row];
      this.target.x = this.layout.width / 2;
      if (row) this.target.y = Math.max(this.target.y, row.y + this.viewport.h / (2 * this.target.zoom) - PAD);
    } else if (mode === 'page') {
      const row = this.layout.rows[page.row];
      const rowW = this.layout.width;
      const rowH = row ? row.h : page.h;
      this.target.zoom = clamp(
        Math.min(this.viewport.w / (rowW + PAD * 2), this.viewport.h / (rowH + PAD * 2)),
        MIN_ZOOM,
        MAX_ZOOM
      );
      this.target.x = this.layout.width / 2;
      if (row) this.target.y = row.y + rowH / 2;
    } else if (mode === 'height') {
      const row = this.layout.rows[page.row];
      const rowH = row ? row.h : page.h;
      this.target.zoom = clamp(this.viewport.h / (rowH + PAD * 2), MIN_ZOOM, MAX_ZOOM);
      this.target.x = this.layout.width / 2;
      if (row) this.target.y = row.y + rowH / 2;
    } else if (mode === 'actual') {
      this.target.zoom = 1;
    }
    this.#clampTarget();
    this.requestFrame();
    if (!silent) this.emit();
  }

  scrollBy(dx, dy) {
    this.target.x += dx / this.target.zoom;
    this.target.y += dy / this.target.zoom;
    this.#clampTarget();
    this.requestFrame();
  }

  goToPage(index, { top = true, immediate = false } = {}) {
    const i = clamp(Math.round(index), 0, this.numPages - 1);
    const page = this.layout.pages[i];
    if (!page) return;
    const row = this.layout.rows[page.row];
    this.target.x = this.layout.width / 2;
    const visH = this.viewport.h / this.target.zoom;
    this.target.y = top ? (row ? row.y : page.y) - PAD / 2 + visH / 2 : page.y + page.h / 2;
    this.#clampTarget();
    if (immediate) this.#snapCamera();
    this.currentPage = i;
    this.requestFrame();
    this.emit();
  }

  stepPage(delta) {
    if (this.presentation) {
      this.goToPage(this.currentPage + delta, { immediate: false });
      return;
    }
    const row = this.layout.pages[this.currentPage]?.row ?? 0;
    const rows = this.layout.rows;
    const nextRow = clamp(row + delta, 0, rows.length - 1);
    const first = rows[nextRow]?.pages[0];
    if (first !== undefined) this.goToPage(first);
  }

  async goToDestination(dest) {
    if (!dest || !this.doc) return;
    try {
      const resolved = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(resolved)) return;
      const ref = resolved[0];
      const pageIndex = typeof ref === 'object' ? await this.doc.getPageIndex(ref) : Number(ref);
      if (!Number.isInteger(pageIndex)) return;
      this.goToPage(pageIndex);

      // /XYZ destinations carry a y offset in PDF user space; honour it so
      // links land on the paragraph rather than the top of the page.
      const kind = resolved[1]?.name;
      if (kind === 'XYZ' && typeof resolved[3] === 'number') {
        const page = await this.getPage(pageIndex);
        const vp = page.getViewport({ scale: 1, rotation: this.rotation });
        const [, py] = vp.convertToViewportPoint(resolved[2] ?? 0, resolved[3]);
        const rect = this.layout.pages[pageIndex];
        if (rect) {
          this.target.y = rect.y + py + this.viewport.h / (2 * this.target.zoom) - PAD;
          this.#clampTarget();
          this.requestFrame();
        }
      }
    } catch (err) {
      console.warn('destination failed:', err);
    }
  }

  // ------------------------------------------------------------------- find

  async find(query, opts = {}) {
    await this.finder.find(query, { ...opts, startPage: this.currentPage });
  }

  findStep(delta) {
    const match = this.finder.step(delta);
    if (match) this.#reveal(match);
  }

  #onFindUpdate(state) {
    this.overlay.setHighlights(this.finder.highlightMap());
    if (state.match && state.current >= 0) this.#reveal(state.match, false);
    this.requestFrame();
    this.onState({ find: state });
  }

  #reveal(match, force = true) {
    if (!match) return;
    const page = this.layout.pages[match.page];
    if (!page) return;
    const view = this.targetRect;
    const pageVisible = page.y < view.y + view.h && page.y + page.h > view.y;
    if (force || !pageVisible) this.goToPage(match.page);
    // The precise rect only exists once the overlay for that page has built;
    // the frame loop finishes the job.
    this.pendingReveal = { page: match.page, tries: 0 };
    this.requestFrame();
  }

  #tryReveal() {
    const req = this.pendingReveal;
    if (!req) return;
    if (++req.tries > 90) {
      this.pendingReveal = null;
      return;
    }
    const layer = this.overlay.layers.get(req.page);
    const active = layer?.highlightEl.querySelector('.hl-active');
    if (!active) return;
    this.pendingReveal = null;
    const rect = this.layout.pages[req.page];
    const x = rect.x + parseFloat(active.style.left) + parseFloat(active.style.width) / 2;
    const y = rect.y + parseFloat(active.style.top) + parseFloat(active.style.height) / 2;
    const view = this.targetRect;
    const inset = 0.15;
    if (
      x < view.x + view.w * inset ||
      x > view.x + view.w * (1 - inset) ||
      y < view.y + view.h * inset ||
      y > view.y + view.h * (1 - inset)
    ) {
      this.target.x = x;
      this.target.y = y;
      this.#clampTarget();
      this.requestFrame();
    }
  }

  // ------------------------------------------------------------ frame loop

  requestFrame() {
    this.needsFrame = true;
  }

  #loop(now) {
    if (!this.running) return;
    requestAnimationFrame(this.#tick);
    const dt = this.lastTime ? Math.min(0.05, (now - this.lastTime) / 1000) : 0.016;
    this.lastTime = now;

    const moving = this.#ease(dt);
    if (!moving && !this.needsFrame) return;
    this.needsFrame = false;

    this.fps = this.fps ? this.fps * 0.9 + (1 / Math.max(dt, 1e-4)) * 0.1 : 1 / Math.max(dt, 1e-4);
    this.#frame();
    this.#tryReveal();
  }

  #ease(dt) {
    const t = this.target;
    const c = this.cam;
    const k = 1 - Math.exp(-dt * EASE_RATE);
    const dz = Math.log(t.zoom) - Math.log(c.zoom);
    const dx = t.x - c.x;
    const dy = t.y - c.y;
    const done = Math.abs(dz) < 1e-4 && Math.abs(dx) * c.zoom < 0.05 && Math.abs(dy) * c.zoom < 0.05;
    if (done) {
      if (c.x === t.x && c.y === t.y && c.zoom === t.zoom) return false;
      c.x = t.x;
      c.y = t.y;
      c.zoom = t.zoom;
      return true;
    }
    c.zoom = Math.exp(Math.log(c.zoom) + dz * k);
    c.x += dx * k;
    c.y += dy * k;
    return true;
  }

  #frame() {
    const r = this.renderer;
    if (r.contextLost) return;
    const theme = this.dark ? THEMES.dark : THEMES.light;
    // Dark mode themes the chrome and the surround only: page pixels are shown
    // exactly as the document specifies them, never inverted.
    r.invert = 0;
    r.beginFrame(theme.bg);

    this.cache.frame++;
    const dpr = this.dpr;
    const view = this.viewRect;
    const margin = Math.max(view.w, view.h) * PREFETCH_MARGIN;
    const drawn = visiblePages(this.layout, view, 0);
    const nearby = visiblePages(this.layout, view, margin);

    const rasterScale = Math.min(this.cam.zoom * dpr, MAX_RASTER_SCALE);
    const lodIndex = Math.round(Math.log2(rasterScale) * LOD_STEPS);
    const wanted = new Set();

    // Screen-space transform, in device pixels.
    const s = this.cam.zoom * dpr;
    const originX = r.width / 2 - this.cam.x * s;
    const originY = r.height / 2 - this.cam.y * s;
    const toScreen = (x, y) => [x * s + originX, y * s + originY];

    for (const page of drawn) {
      const [px, py] = toScreen(page.x, page.y);
      const pw = page.w * s;
      const ph = page.h * s;
      r.drawShadow(px, py, pw, ph, Math.max(6, 10 * dpr), theme.shadow);
      r.drawRect(px, py, pw, ph, [1, 1, 1, 1]);

      const prevKey = previewKey(page.index, this.rotation);
      const prev = this.cache.use(prevKey);
      if (prev) r.drawTexture(prev.tex, px, py, pw, ph);

      // Coarse to fine: whatever is resident at a lower level fills the gap
      // until the current level's tiles arrive, so zooming never flashes empty.
      for (let l = lodIndex - LOD_FALLBACKS; l <= lodIndex; l++) {
        if (l === lodIndex) continue;
        this.#drawTilesAtLod(page, l, view, toScreen, s, false, wanted);
      }
      this.#drawTilesAtLod(page, lodIndex, view, toScreen, s, true, wanted);
    }

    for (const page of nearby) {
      wanted.add(previewKey(page.index, this.rotation));
      this.#requestPreview(page, drawn.includes(page));
    }

    this.#drawScrollbars(r, dpr);

    // Anything queued that this frame did not ask for is stale by definition --
    // except pinned work (thumbnails, print), which no frame ever asks for.
    this.pool.cancelWhere((key, job) => job.pinned || wanted.has(key));
    this.cache.sweep();

    const page = pageAtViewport(this.layout, view);
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.emit();
    }
    this.overlay.update(drawn, this.cam, this.viewport);
  }

  #tileGeometry(page, lod) {
    const scale = Math.pow(2, lod / LOD_STEPS);
    const pw = Math.max(1, Math.ceil(page.w * scale));
    const ph = Math.max(1, Math.ceil(page.h * scale));
    return { scale, pw, ph, cols: Math.ceil(pw / TILE), rows: Math.ceil(ph / TILE) };
  }

  #drawTilesAtLod(page, lod, view, toScreen, s, request, wanted) {
    if (lod < -LOD_STEPS * 4) return;
    const g = this.#tileGeometry(page, lod);
    // Below the preview's resolution a tile is strictly worse than the preview
    // we already drew, so there is nothing to gain from fetching one.
    if (g.pw <= PREVIEW_MAX_PX && g.ph <= PREVIEW_MAX_PX && request) return;

    const lx0 = Math.max(0, (view.x - page.x) * g.scale);
    const ly0 = Math.max(0, (view.y - page.y) * g.scale);
    const lx1 = Math.min(g.pw, (view.x + view.w - page.x) * g.scale);
    const ly1 = Math.min(g.ph, (view.y + view.h - page.y) * g.scale);
    if (lx1 <= lx0 || ly1 <= ly0) return;

    const tx0 = Math.floor(lx0 / TILE);
    const ty0 = Math.floor(ly0 / TILE);
    const tx1 = Math.min(g.cols - 1, Math.floor((lx1 - 0.001) / TILE));
    const ty1 = Math.min(g.rows - 1, Math.floor((ly1 - 0.001) / TILE));

    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = tileKey(page.index, this.rotation, lod, tx, ty);
        const ox = tx * TILE;
        const oy = ty * TILE;
        const tw = Math.min(TILE, g.pw - ox);
        const th = Math.min(TILE, g.ph - oy);
        const dx = page.x + ox / g.scale;
        const dy = page.y + oy / g.scale;
        const dw = tw / g.scale;
        const dh = th / g.scale;

        const entry = this.cache.use(key);
        if (entry) {
          const [sx, sy] = toScreen(dx, dy);
          this.renderer.drawTexture(entry.tex, sx, sy, dw * s, dh * s);
        }
        if (!request) continue;
        wanted.add(key);
        if (entry || this.pool.isPending(key)) {
          if (!entry) {
            const d = Math.hypot(dx + dw / 2 - cx, dy + dh / 2 - cy);
            this.pool.setPriority(key, d);
          }
          continue;
        }
        const priority = Math.hypot(dx + dw / 2 - cx, dy + dh / 2 - cy);
        this.#submit({
          key,
          priority,
          pageIndex: page.index,
          rotation: this.rotation,
          scale: g.scale,
          ox,
          oy,
          width: tw,
          height: th,
        });
      }
    }
  }

  #requestPreview(page, visible) {
    const key = previewKey(page.index, this.rotation);
    if (this.cache.has(key) || this.pool.isPending(key)) return;
    const scale = Math.min(1, PREVIEW_MAX_PX / Math.max(page.w, page.h));
    this.#submit({
      key,
      // Previews unblock everything else, so they jump the queue; off-screen
      // prefetch still yields to anything actually on screen.
      priority: visible ? -1e6 : -1,
      pageIndex: page.index,
      rotation: this.rotation,
      scale,
      ox: 0,
      oy: 0,
      width: Math.max(1, Math.ceil(page.w * scale)),
      height: Math.max(1, Math.ceil(page.h * scale)),
    });
  }

  #submit(job) {
    this.pool
      .submit(job)
      .then(({ bitmap }) => {
        this.cache.put(job.key, bitmap);
        this.requestFrame();
      })
      .catch((err) => {
        if (!isCancelled(err)) console.warn('tile failed:', job.key, err.message, err.workerStack || '');
      });
  }

  /**
   * Rasterize a whole page on the same worker pool, outside the tile system.
   * Used by thumbnails and printing; `pinned` keeps the job alive across the
   * frame loop's stale-work sweep.
   */
  rasterizePage(pageIndex, { scale, key, priority = 1e6 }) {
    const page = this.layout.pages[pageIndex];
    if (!page) return Promise.reject(new Error('no such page'));
    return this.pool.submit({
      key,
      priority,
      pinned: true,
      pageIndex,
      rotation: this.rotation,
      scale,
      ox: 0,
      oy: 0,
      width: Math.max(1, Math.ceil(page.w * scale)),
      height: Math.max(1, Math.ceil(page.h * scale)),
    });
  }

  // ------------------------------------------------------------- scrollbars

  #drawScrollbars(r, dpr) {
    const W = 10 * dpr;
    const pad = 2 * dpr;
    const view = this.viewRect;
    const track = this.dark ? [1, 1, 1, 0.13] : [0, 0, 0, 0.18];
    this.scrollbars.v = null;
    this.scrollbars.h = null;

    if (this.layout.height > view.h + 0.5) {
      const frac = Math.min(1, view.h / this.layout.height);
      const len = Math.max(28 * dpr, (r.height - pad * 2) * frac);
      const range = r.height - pad * 2 - len;
      const t = clamp(view.y / (this.layout.height - view.h), 0, 1);
      const y = pad + range * t;
      const x = r.width - W - pad;
      r.drawRect(x, y, W, len, track);
      this.scrollbars.v = { x: x / dpr, y: y / dpr, w: W / dpr, h: len / dpr, range: range / dpr, pad: pad / dpr };
    }
    if (this.layout.width > view.w + 0.5) {
      const frac = Math.min(1, view.w / this.layout.width);
      const len = Math.max(28 * dpr, (r.width - pad * 2) * frac);
      const range = r.width - pad * 2 - len;
      const t = clamp(view.x / (this.layout.width - view.w), 0, 1);
      const x = pad + range * t;
      const y = r.height - W - pad;
      r.drawRect(x, y, len, W, track);
      this.scrollbars.h = { x: x / dpr, y: y / dpr, w: len / dpr, h: W / dpr, range: range / dpr, pad: pad / dpr };
    }
  }

  // ------------------------------------------------------------------ input

  #installObservers() {
    this.resizeObserver = new ResizeObserver(() => this.#onResize());
    this.resizeObserver.observe(this.stage);
    this.#onResize();
    this.#watchDpr();
  }

  #watchDpr() {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
      this.dpr = window.devicePixelRatio || 1;
      // Tiles were rasterized for the old density; they would look soft on the
      // new one, and the LOD picker will ask for fresh ones anyway.
      this.cache.clear();
      this.#onResize();
      this.#watchDpr();
    };
    mq.addEventListener('change', onChange, { once: true });
  }

  #onResize() {
    const rect = this.stage.getBoundingClientRect();
    this.viewport = { w: Math.max(1, rect.width), h: Math.max(1, rect.height) };
    this.renderer.resize(this.viewport.w, this.viewport.h, this.dpr);
    if (this.fit !== 'none') this.setFit(this.fit, true);
    this.#clampTarget();
    this.requestFrame();
  }

  #installInput() {
    const c = this.stage;

    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.doc) return;
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewport.h : 1;
        if (e.ctrlKey || e.metaKey) {
          this.zoomBy(Math.exp(-e.deltaY * unit * 0.0035), anchor);
        } else if (e.shiftKey) {
          this.scrollBy(e.deltaY * unit, 0);
        } else {
          this.scrollBy(e.deltaX * unit, e.deltaY * unit);
        }
      },
      { passive: false }
    );

    const pointers = new Map();
    let pan = null;
    let pinch = null;

    c.addEventListener('pointerdown', (e) => {
      if (!this.doc) return;
      const rect = c.getBoundingClientRect();
      const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      const bar = this.#hitScrollbar(local);
      if (bar && e.button === 0) {
        c.setPointerCapture(e.pointerId);
        this.scrollbars.drag = { axis: bar.axis, grab: bar.grab, start: local };
        e.preventDefault();
        return;
      }

      pointers.set(e.pointerId, local);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          zoom: this.target.zoom,
          center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        pan = null;
        return;
      }

      const wantsPan =
        e.button === 1 || this.tool === 'pan' || this.spaceDown || e.pointerType === 'touch' || e.target === this.canvas;
      if (!wantsPan) return;
      c.setPointerCapture(e.pointerId);
      pan = { last: local, velocity: { x: 0, y: 0 }, moved: false };
      c.classList.add('grabbing');
      e.preventDefault();
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.doc) return;
      const rect = c.getBoundingClientRect();
      const local = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, local);

      const drag = this.scrollbars.drag;
      if (drag) {
        this.#dragScrollbar(drag, local);
        return;
      }

      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.dist > 4) {
          const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          this.setZoom(pinch.zoom * (dist / pinch.dist), center, true);
          const dx = center.x - pinch.center.x;
          const dy = center.y - pinch.center.y;
          this.scrollBy(-dx, -dy);
          this.#snapCamera();
          pinch.center = center;
        }
        return;
      }

      if (!pan) return;
      const dx = local.x - pan.last.x;
      const dy = local.y - pan.last.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) pan.moved = true;
      pan.last = local;
      pan.velocity = { x: dx, y: dy };
      this.scrollBy(-dx, -dy);
      this.#snapCamera();
    });

    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      this.scrollbars.drag = null;
      if (pan) {
        // Flick to keep scrolling; the eased camera turns the throw into glide.
        const v = pan.velocity;
        if (pan.moved && Math.hypot(v.x, v.y) > 4) this.scrollBy(-v.x * 8, -v.y * 8);
        pan = null;
        c.classList.remove('grabbing');
      }
    };
    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);
    c.addEventListener('contextmenu', (e) => {
      if (e.target === this.canvas) e.preventDefault();
    });
  }

  #hitScrollbar(p) {
    const hit = (b) => b && p.x >= b.x - 4 && p.x <= b.x + b.w + 4 && p.y >= b.y - 4 && p.y <= b.y + b.h + 4;
    if (hit(this.scrollbars.v)) return { axis: 'v', grab: p.y - this.scrollbars.v.y };
    if (hit(this.scrollbars.h)) return { axis: 'h', grab: p.x - this.scrollbars.h.x };
    return null;
  }

  #dragScrollbar(drag, p) {
    const bar = this.scrollbars[drag.axis];
    if (!bar || bar.range <= 0) return;
    const view = this.viewRect;
    if (drag.axis === 'v') {
      const t = clamp((p.y - drag.grab - bar.pad) / bar.range, 0, 1);
      this.target.y = t * (this.layout.height - view.h) + view.h / 2;
    } else {
      const t = clamp((p.x - drag.grab - bar.pad) / bar.range, 0, 1);
      this.target.x = t * (this.layout.width - view.w) + view.w / 2;
    }
    this.#clampTarget();
    this.#snapCamera();
  }

  // ---------------------------------------------------------------- exports

  setDark(on) {
    this.dark = on;
    this.requestFrame();
    this.emit();
  }

  setTool(tool) {
    this.tool = tool;
    this.stage.classList.toggle('tool-pan', tool === 'pan');
    this.emit();
  }

  download() {
    const blob = new Blob([this.bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /**
   * Rasterize every page into a hidden container and hand it to the browser's
   * print dialog. The GPU canvas only ever holds the visible viewport, so it
   * cannot be printed directly.
   */
  async print(onProgress) {
    const host = document.createElement('div');
    host.id = 'printHost';
    document.body.append(host);
    const PRINT_DPI = 150;
    try {
      for (let i = 0; i < this.numPages; i++) {
        const page = this.layout.pages[i];
        const scale = Math.min(PRINT_DPI / 72, 2200 / Math.max(page.w, page.h));
        const { bitmap } = await this.rasterizePage(i, {
          scale,
          key: `print:${i}`,
          priority: -1e9 + i,
        });
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        const wrap = document.createElement('div');
        wrap.className = 'printPage';
        wrap.style.setProperty('--page-aspect', String(page.w / page.h));
        wrap.append(canvas);
        host.append(wrap);
        onProgress?.(i + 1, this.numPages);
      }
      document.body.classList.add('printing');
      await new Promise((r) => setTimeout(r, 60));
      window.print();
    } finally {
      document.body.classList.remove('printing');
      host.remove();
    }
  }

  get stats() {
    return {
      fps: this.fps,
      drawCalls: this.renderer.drawCalls,
      textures: this.cache.entries.size,
      vram: this.cache.bytes,
      pending: this.pool.pending,
      workers: this.pool.size,
      adapter: this.renderer.adapter,
      uploads: this.cache.uploads,
      evictions: this.cache.evictions,
    };
  }

  emit() {
    this.onState({
      page: this.currentPage,
      numPages: this.numPages,
      zoom: this.target.zoom,
      fit: this.fit,
      rotation: this.rotation,
      spread: this.spread,
      dark: this.dark,
      tool: this.tool,
      filename: this.filename,
      title: this.meta?.info?.Title || '',
      outline: this.outline,
    });
  }

  destroy() {
    this.running = false;
    this.resizeObserver.disconnect();
    this.#teardownDoc();
    this.pool.destroy();
    this.renderer.destroy();
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const tileKey = (page, rot, lod, tx, ty) => `${page}:${rot}:${lod}:${tx}:${ty}`;
const previewKey = (page, rot) => `${page}:${rot}:P`;
