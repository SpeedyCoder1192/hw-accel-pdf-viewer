// DOM overlays that ride on top of the GPU canvas.
//
// The canvas cannot be selected, searched or clicked, so every visible page also
// gets a transparent DOM layer holding pdf.js text spans, link anchors and
// search highlights. These are built once per page at scale 1 (doc units) and
// then moved with a single CSS transform, so a zoom gesture costs one style
// write per visible page instead of a relayout of thousands of spans.

import { TextLayer } from 'pdfjs-dist';

export class OverlayManager {
  /**
   * @param {HTMLElement} root container sized to the viewport
   * @param {object} deps { getPage, getTextContent, getAnnotations, getRotation,
   *                        onInternalLink, onExternalLink }
   */
  constructor(root, deps) {
    this.root = root;
    this.deps = deps;
    this.layers = new Map(); // pageIndex -> layer record
    this.enabled = true;
    this.highlights = new Map(); // pageIndex -> [{ start, end, active }]
    this.generation = 0;
  }

  reset() {
    this.generation++;
    for (const layer of this.layers.values()) layer.el.remove();
    this.layers.clear();
    this.highlights.clear();
  }

  setEnabled(on) {
    this.enabled = on;
    this.root.style.display = on ? '' : 'none';
  }

  /** Called every frame with the pages the compositor is drawing. */
  update(pages, camera, viewport) {
    if (!this.enabled) return;
    const wanted = new Set();
    for (const p of pages) {
      wanted.add(p.index);
      let layer = this.layers.get(p.index);
      if (!layer) layer = this.#createLayer(p);
      const sx = (p.x - camera.x) * camera.zoom + viewport.w / 2;
      const sy = (p.y - camera.y) * camera.zoom + viewport.h / 2;
      const t = `translate(${sx.toFixed(2)}px, ${sy.toFixed(2)}px) scale(${camera.zoom})`;
      if (layer.transform !== t) {
        layer.el.style.transform = t;
        layer.transform = t;
      }
    }
    for (const [index, layer] of [...this.layers]) {
      if (!wanted.has(index)) {
        layer.el.remove();
        layer.cancelled = true;
        this.layers.delete(index);
      }
    }
  }

  #createLayer(page) {
    const el = document.createElement('div');
    el.className = 'pageLayer';
    el.style.width = `${page.w}px`;
    el.style.height = `${page.h}px`;
    // pdf.js positions every span with calc(var(--scale-factor) * Npx); pinning
    // it to 1 keeps those spans in doc units so the CSS transform can do the
    // scaling for free.
    el.style.setProperty('--scale-factor', '1');

    const highlightEl = document.createElement('div');
    highlightEl.className = 'highlightLayer';
    const textEl = document.createElement('div');
    textEl.className = 'textLayer';
    const annotEl = document.createElement('div');
    annotEl.className = 'annotLayer';
    el.append(highlightEl, textEl, annotEl);
    this.root.append(el);

    const layer = {
      el,
      textEl,
      highlightEl,
      annotEl,
      index: page.index,
      transform: null,
      built: false,
      cancelled: false,
      textLayer: null,
      itemOffsets: null,
      generation: this.generation,
    };
    this.layers.set(page.index, layer);
    this.#build(layer);
    return layer;
  }

  async #build(layer) {
    const gen = this.generation;
    const alive = () => !layer.cancelled && gen === this.generation;
    try {
      const [page, textContent] = await Promise.all([
        this.deps.getPage(layer.index),
        this.deps.getTextContent(layer.index),
      ]);
      if (!alive()) return;
      const viewport = page.getViewport({ scale: 1, rotation: this.deps.getRotation(layer.index) });

      const tl = new TextLayer({ textContentSource: textContent, container: layer.textEl, viewport });
      await tl.render();
      if (!alive()) return;
      layer.textLayer = tl;

      // Offsets let a search hit expressed in page-text coordinates be turned
      // back into a DOM Range across these spans.
      const strs = tl.textContentItemsStr;
      const offsets = new Array(strs.length);
      let acc = 0;
      for (let i = 0; i < strs.length; i++) {
        offsets[i] = acc;
        acc += strs[i].length;
      }
      layer.itemOffsets = offsets;
      layer.textLength = acc;
      layer.built = true;
      this.#renderHighlights(layer);

      this.#buildAnnotations(layer, page, viewport, alive);
    } catch (err) {
      if (alive()) console.warn(`overlay for page ${layer.index + 1} failed:`, err);
    }
  }

  async #buildAnnotations(layer, page, viewport, alive) {
    const annots = await this.deps.getAnnotations(layer.index);
    if (!alive()) return;
    const frag = document.createDocumentFragment();
    for (const a of annots) {
      if (a.subtype !== 'Link' || (!a.url && !a.dest && !a.action)) continue;
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      if (w < 1 || h < 1) continue;

      const el = document.createElement('a');
      el.className = 'annotLink';
      el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      if (a.url) {
        el.href = a.url;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        el.title = a.url;
      } else {
        el.href = '#';
        el.title = 'Go to destination';
        el.addEventListener('click', (e) => {
          e.preventDefault();
          this.deps.onInternalLink(a.dest ?? a.action);
        });
      }
      frag.append(el);
    }
    layer.annotEl.replaceChildren(frag);
  }

  setHighlights(map) {
    this.highlights = map;
    for (const layer of this.layers.values()) {
      if (layer.built) this.#renderHighlights(layer);
    }
  }

  #renderHighlights(layer) {
    const ranges = this.highlights.get(layer.index);
    if (!ranges || ranges.length === 0) {
      layer.highlightEl.replaceChildren();
      return;
    }
    const box = layer.el.getBoundingClientRect();
    // The layer is CSS-scaled, so client rects come back in screen pixels;
    // dividing by the live scale puts highlights back into doc units where they
    // stay correct through any later zoom.
    const scale = box.width / (parseFloat(layer.el.style.width) || 1) || 1;
    const divs = layer.textLayer.textDivs;
    const offsets = layer.itemOffsets;
    const frag = document.createDocumentFragment();

    for (const r of ranges) {
      const range = document.createRange();
      const start = locate(divs, offsets, r.start);
      const end = locate(divs, offsets, r.end, true);
      if (!start || !end) continue;
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
      } catch {
        continue;
      }
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        const div = document.createElement('div');
        div.className = r.active ? 'hl hl-active' : 'hl';
        div.style.cssText =
          `left:${(rect.left - box.left) / scale}px;` +
          `top:${(rect.top - box.top) / scale}px;` +
          `width:${rect.width / scale}px;` +
          `height:${rect.height / scale}px`;
        frag.append(div);
      }
    }
    layer.highlightEl.replaceChildren(frag);
  }

  /** Screen rect (CSS px, viewport-relative) for a highlight, for scroll-into-view. */
  hasLayer(pageIndex) {
    return this.layers.get(pageIndex)?.built ?? false;
  }
}

/** Binary-search the item that contains a page-text offset, then its text node. */
function locate(divs, offsets, offset, isEnd = false) {
  let lo = 0;
  let hi = offsets.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= offset) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return null;
  // An end offset landing exactly on an item boundary belongs to the previous
  // item, otherwise the range would extend one span too far.
  if (isEnd && offsets[idx] === offset && idx > 0) idx--;
  const div = divs[idx];
  const node = div?.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const local = Math.max(0, Math.min(offset - offsets[idx], node.textContent.length));
  return { node, offset: local };
}
