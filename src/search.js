// Full-document find.
//
// Page text is fetched lazily and cached; a search streams results page by page
// so a hit on page 2 is usable long before page 900 has been parsed.

const WORD_CHAR = /[\p{L}\p{N}_]/u;

export class Finder {
  constructor({ numPages, getTextContent, onUpdate }) {
    this.numPages = numPages;
    this.getTextContent = getTextContent;
    this.onUpdate = onUpdate;
    this.cache = new Map(); // pageIndex -> normalized page text
    this.matches = [];
    this.current = -1;
    this.query = '';
    this.opts = { caseSensitive: false, wholeWord: false };
    this.token = 0;
    this.scanning = false;
  }

  reset() {
    this.token++;
    this.matches = [];
    this.current = -1;
    this.query = '';
    this.scanning = false;
    this.onUpdate(this.state());
  }

  state() {
    return {
      query: this.query,
      total: this.matches.length,
      current: this.current,
      scanning: this.scanning,
      match: this.matches[this.current] ?? null,
    };
  }

  async #pageText(pageIndex) {
    let text = this.cache.get(pageIndex);
    if (text === undefined) {
      const content = await this.getTextContent(pageIndex);
      text = content.items.map((it) => it.str ?? '').join('');
      this.cache.set(pageIndex, text);
    }
    return text;
  }

  /**
   * @param {string} query
   * @param {object} opts { caseSensitive, wholeWord, startPage }
   */
  async find(query, opts = {}) {
    const token = ++this.token;
    this.query = query;
    this.opts = { caseSensitive: !!opts.caseSensitive, wholeWord: !!opts.wholeWord };
    this.matches = [];
    this.current = -1;
    if (!query) {
      this.scanning = false;
      this.onUpdate(this.state());
      return;
    }
    this.scanning = true;
    this.onUpdate(this.state());

    const startPage = Math.max(0, Math.min(opts.startPage ?? 0, this.numPages - 1));
    // Visit the current page first so the first hit is usually on screen, but
    // keep `matches` in document order so next/prev stay intuitive.
    const order = [];
    for (let i = 0; i < this.numPages; i++) order.push((startPage + i) % this.numPages);

    const CONCURRENCY = 8;
    let cursor = 0;
    let firstReported = false;

    const worker = async () => {
      while (cursor < order.length) {
        const pageIndex = order[cursor++];
        if (token !== this.token) return;
        let text;
        try {
          text = await this.#pageText(pageIndex);
        } catch {
          continue;
        }
        if (token !== this.token) return;
        const hits = findAll(text, query, this.opts);
        if (hits.length === 0) continue;
        for (const h of hits) this.matches.push({ page: pageIndex, start: h[0], end: h[1] });
        this.matches.sort((a, b) => a.page - b.page || a.start - b.start);
        if (!firstReported) {
          firstReported = true;
          this.current = this.matches.findIndex((m) => m.page === pageIndex);
        } else if (this.current >= 0) {
          // Keep pointing at the same hit as earlier pages fill in around it.
          const cur = this.matches[this.current];
          this.current = this.matches.indexOf(cur);
        }
        this.onUpdate(this.state());
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (token !== this.token) return;
    this.scanning = false;
    if (this.current < 0 && this.matches.length > 0) this.current = 0;
    this.onUpdate(this.state());
  }

  step(delta) {
    if (this.matches.length === 0) return null;
    this.current = (this.current + delta + this.matches.length) % this.matches.length;
    this.onUpdate(this.state());
    return this.matches[this.current];
  }

  /** Map of pageIndex -> highlight ranges, for the overlay layer. */
  highlightMap() {
    const map = new Map();
    for (let i = 0; i < this.matches.length; i++) {
      const m = this.matches[i];
      let list = map.get(m.page);
      if (!list) map.set(m.page, (list = []));
      list.push({ start: m.start, end: m.end, active: i === this.current });
    }
    return map;
  }
}

function findAll(text, query, { caseSensitive, wholeWord }) {
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];
  const out = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    const end = i + needle.length;
    from = i + 1;
    if (wholeWord) {
      const before = i > 0 ? hay[i - 1] : '';
      const after = end < hay.length ? hay[end] : '';
      if ((before && WORD_CHAR.test(before)) || (after && WORD_CHAR.test(after))) continue;
    }
    out.push([i, end]);
    if (out.length > 5000) break; // pathological queries ("e") on huge pages
  }
  return out;
}
