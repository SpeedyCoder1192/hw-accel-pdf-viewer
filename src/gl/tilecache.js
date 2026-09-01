// LRU cache of GPU textures, budgeted in bytes of VRAM.
//
// Textures are only ever evicted when they were *not* drawn in the current
// frame, so a sweep can never pull a tile out from under the frame that needs
// it -- the worst case is that we sit slightly over budget for one frame.

const MIP_OVERHEAD = 4 / 3; // full mip chain adds ~33% on top of level 0

export class TileCache {
  constructor(renderer, budgetBytes = 384 * 1024 * 1024) {
    this.renderer = renderer;
    this.budget = budgetBytes;
    this.entries = new Map(); // key -> { tex, w, h, bytes, lastFrame }
    this.bytes = 0;
    this.frame = 0;
    this.uploads = 0;
    this.evictions = 0;
  }

  has(key) {
    return this.entries.has(key);
  }

  /** Look a tile up and mark it as touched by the current frame. */
  use(key) {
    const e = this.entries.get(key);
    if (e) e.lastFrame = this.frame;
    return e;
  }

  put(key, bitmap) {
    const existing = this.entries.get(key);
    if (existing) {
      bitmap.close();
      return existing;
    }
    const tex = this.renderer.createTexture(bitmap);
    const { width: w, height: h } = bitmap;
    bitmap.close();
    const entry = { tex, w, h, bytes: Math.ceil(w * h * 4 * MIP_OVERHEAD), lastFrame: this.frame };
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    this.uploads++;
    return entry;
  }

  delete(key) {
    const e = this.entries.get(key);
    if (!e) return;
    this.renderer.deleteTexture(e.tex);
    this.bytes -= e.bytes;
    this.entries.delete(key);
  }

  /** Drop least-recently-drawn textures until we are back under budget. */
  sweep() {
    if (this.bytes <= this.budget) return;
    const stale = [];
    for (const [key, e] of this.entries) {
      if (e.lastFrame !== this.frame) stale.push([key, e.lastFrame]);
    }
    stale.sort((a, b) => a[1] - b[1]);
    for (const [key] of stale) {
      if (this.bytes <= this.budget) break;
      this.delete(key);
      this.evictions++;
    }
  }

  /** Drop everything matching a predicate on the key (e.g. a rotated page). */
  purge(predicate) {
    for (const key of [...this.entries.keys()]) {
      if (predicate(key)) this.delete(key);
    }
  }

  clear() {
    for (const key of [...this.entries.keys()]) this.delete(key);
    this.bytes = 0;
  }
}
