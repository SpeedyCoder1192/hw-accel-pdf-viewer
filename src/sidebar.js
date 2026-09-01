// Sidebar: page thumbnails and the document outline.
//
// Thumbnails go through the same worker pool as everything else, but at a
// deliberately terrible priority: a thumbnail must never delay a tile the user
// is actually looking at. They are also only rendered once they scroll into
// view, so a 900-page document costs 900 empty boxes, not 900 rasterizations.

const THUMB_W = 168; // device px of the rendered bitmap
const THUMB_PRIORITY = 1e5;

export class Sidebar {
  /**
   * @param {object} deps { root, thumbsEl, outlineEl, tabThumbs, tabOutline,
   *                        viewer, onGoto, onDestination }
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.items = [];
    this.rendered = new Map(); // pageIndex -> { canvas, key, rotation }
    this.active = -1;
    this.generation = 0;
    this.visible = false;

    this.observer = new IntersectionObserver((entries) => this.#onIntersect(entries), {
      root: this.thumbsEl,
      rootMargin: '400px 0px',
    });

    this.tabThumbs.addEventListener('click', () => this.selectTab('thumbs'));
    this.tabOutline.addEventListener('click', () => this.selectTab('outline'));
  }

  selectTab(which) {
    const thumbs = which === 'thumbs';
    this.tabThumbs.classList.toggle('active', thumbs);
    this.tabOutline.classList.toggle('active', !thumbs);
    this.tabThumbs.setAttribute('aria-selected', String(thumbs));
    this.tabOutline.setAttribute('aria-selected', String(!thumbs));
    this.thumbsEl.hidden = !thumbs;
    this.outlineEl.hidden = thumbs;
    if (thumbs) this.scrollActiveIntoView();
  }

  toggle(force) {
    this.visible = force ?? !this.visible;
    this.root.hidden = !this.visible;
    if (this.visible) this.scrollActiveIntoView();
    return this.visible;
  }

  reset() {
    this.generation++;
    this.observer.disconnect();
    this.items = [];
    this.rendered.clear();
    this.active = -1;
    this.thumbsEl.replaceChildren();
    this.outlineEl.replaceChildren();
  }

  /** Build the (empty) thumbnail strip for a freshly opened document. */
  setDocument(viewer) {
    this.reset();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < viewer.numPages; i++) {
      const page = viewer.layout.pages[i];
      const aspect = page ? page.h / page.w : 1.294;

      const btn = document.createElement('button');
      btn.className = 'thumb';
      btn.type = 'button';
      btn.dataset.page = String(i);
      btn.title = `Page ${i + 1}`;

      const frame = document.createElement('div');
      frame.className = 'frame';
      frame.style.aspectRatio = `1 / ${aspect.toFixed(4)}`;

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);

      btn.append(frame, num);
      btn.addEventListener('click', () => this.onGoto(i));
      frag.append(btn);
      this.items.push({ el: btn, frame, index: i });
    }
    this.thumbsEl.append(frag);
    for (const item of this.items) this.observer.observe(item.el);
    this.setOutline(viewer.outline);
  }

  /** Rotation or spread changed: aspect ratios and pixels are both stale. */
  invalidate(viewer) {
    this.generation++;
    this.rendered.clear();
    for (const item of this.items) {
      const page = viewer.layout.pages[item.index];
      if (page) item.frame.style.aspectRatio = `1 / ${(page.h / page.w).toFixed(4)}`;
      item.frame.replaceChildren();
      item.pending = false;
    }
    // Re-run intersection callbacks for whatever is currently on screen.
    this.observer.disconnect();
    for (const item of this.items) this.observer.observe(item.el);
  }

  #onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = Number(entry.target.dataset.page);
      this.#render(index);
    }
  }

  async #render(index) {
    const item = this.items[index];
    if (!item || item.pending || this.rendered.has(index)) return;
    const gen = this.generation;
    item.pending = true;
    const viewer = this.viewer();
    const page = viewer?.layout.pages[index];
    if (!page) {
      item.pending = false;
      return;
    }
    const scale = Math.min(1, THUMB_W / page.w);
    try {
      const { bitmap } = await viewer.rasterizePage(index, {
        scale,
        key: `thumb:${index}:${viewer.rotation}`,
        priority: THUMB_PRIORITY + Math.abs(index - this.active),
      });
      if (gen !== this.generation) {
        bitmap.close();
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      item.frame.replaceChildren(canvas);
      this.rendered.set(index, canvas);
    } catch {
      /* cancelled or failed; the box just stays blank until it is re-observed */
    } finally {
      item.pending = false;
    }
  }

  setPage(index) {
    if (index === this.active) return;
    this.items[this.active]?.el.classList.remove('active');
    this.active = index;
    const item = this.items[index];
    if (!item) return;
    item.el.classList.add('active');
    if (this.visible && !this.thumbsEl.hidden) this.scrollActiveIntoView();
  }

  scrollActiveIntoView() {
    const item = this.items[this.active];
    if (!item) return;
    const box = item.el.getBoundingClientRect();
    const panel = this.thumbsEl.getBoundingClientRect();
    if (box.top < panel.top || box.bottom > panel.bottom) {
      item.el.scrollIntoView({ block: 'nearest' });
    }
  }

  setOutline(outline) {
    this.outlineEl.replaceChildren();
    if (!outline || outline.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'No outline in this document.';
      this.outlineEl.append(p);
      this.tabOutline.disabled = false;
      return;
    }
    this.outlineEl.append(this.#buildLevel(outline, 0));
  }

  #buildLevel(items, depth) {
    const ul = document.createElement('ul');
    ul.className = depth === 0 ? 'outlineTree' : '';
    for (const item of items) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'outlineRow';

      const kids = item.items?.length ? this.#buildLevel(item.items, depth + 1) : null;
      if (kids) {
        const twisty = document.createElement('button');
        twisty.className = 'twisty';
        twisty.type = 'button';
        twisty.setAttribute('aria-label', 'Expand');
        // Deep outlines start collapsed below the second level so the panel is
        // navigable rather than a wall of text.
        const open = depth < 1;
        kids.hidden = !open;
        twisty.classList.toggle('open', open);
        twisty.addEventListener('click', () => {
          kids.hidden = !kids.hidden;
          twisty.classList.toggle('open', !kids.hidden);
        });
        row.append(twisty);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'twisty';
        spacer.style.visibility = 'hidden';
        row.append(spacer);
      }

      const btn = document.createElement('button');
      btn.className = 'link';
      btn.type = 'button';
      btn.textContent = item.title || '(untitled)';
      if (item.bold) btn.style.fontWeight = '600';
      if (item.italic) btn.style.fontStyle = 'italic';
      btn.addEventListener('click', () => {
        if (item.url) window.open(item.url, '_blank', 'noopener');
        else this.onDestination(item.dest);
      });
      row.append(btn);

      li.append(row);
      if (kids) li.append(kids);
      ul.append(li);
    }
    return ul;
  }
}
