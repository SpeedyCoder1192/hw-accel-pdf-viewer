// Document layout in "doc units" -- PDF points, independent of zoom.
//
// Keeping layout in points means zooming is purely a camera change: no rect is
// recomputed, nothing reflows, and the GPU just samples the same textures with
// different uniforms.

export const SPREAD = { NONE: 'none', BOOK: 'book', TWO_UP: 'two' };

export const PAGE_GAP = 18;

export function computeLayout(pageSizes, { spread = SPREAD.NONE, gap = PAGE_GAP } = {}) {
  const rows = [];
  if (spread === SPREAD.NONE) {
    for (let i = 0; i < pageSizes.length; i++) rows.push([i]);
  } else if (spread === SPREAD.BOOK) {
    // Cover stands alone so that pages 2/3, 4/5 ... face each other like a book.
    if (pageSizes.length > 0) rows.push([0]);
    for (let i = 1; i < pageSizes.length; i += 2) {
      rows.push(i + 1 < pageSizes.length ? [i, i + 1] : [i]);
    }
  } else {
    for (let i = 0; i < pageSizes.length; i += 2) {
      rows.push(i + 1 < pageSizes.length ? [i, i + 1] : [i]);
    }
  }

  const pages = new Array(pageSizes.length);
  const rowRects = [];
  let width = 0;
  for (const row of rows) {
    let w = 0;
    for (const i of row) w += pageSizes[i].w;
    w += gap * (row.length - 1);
    width = Math.max(width, w);
  }

  let y = gap;
  rows.forEach((row, rowIndex) => {
    let rowW = 0;
    let rowH = 0;
    for (const i of row) {
      rowW += pageSizes[i].w;
      rowH = Math.max(rowH, pageSizes[i].h);
    }
    rowW += gap * (row.length - 1);
    let x = (width - rowW) / 2;
    for (const i of row) {
      const { w, h } = pageSizes[i];
      pages[i] = { index: i, x, y: y + (rowH - h) / 2, w, h, row: rowIndex };
      x += w + gap;
    }
    rowRects.push({ y, h: rowH, pages: row });
    y += rowH + gap;
  });

  return { pages, rows: rowRects, width, height: y };
}

/** Index of the page whose area dominates the viewport -- drives the page counter. */
export function pageAtViewport(layout, view) {
  let best = 0;
  let bestArea = -1;
  for (const p of layout.pages) {
    const w = Math.min(p.x + p.w, view.x + view.w) - Math.max(p.x, view.x);
    const h = Math.min(p.y + p.h, view.y + view.h) - Math.max(p.y, view.y);
    if (w <= 0 || h <= 0) continue;
    const area = w * h;
    if (area > bestArea) {
      bestArea = area;
      best = p.index;
    }
  }
  if (bestArea < 0) {
    // Between pages: fall back to whichever page starts nearest above the view.
    let nearest = 0;
    let dist = Infinity;
    for (const p of layout.pages) {
      const d = Math.abs(p.y - view.y);
      if (d < dist) {
        dist = d;
        nearest = p.index;
      }
    }
    return nearest;
  }
  return best;
}

export function visiblePages(layout, view, margin = 0) {
  const out = [];
  const x0 = view.x - margin;
  const y0 = view.y - margin;
  const x1 = view.x + view.w + margin;
  const y1 = view.y + view.h + margin;
  for (const p of layout.pages) {
    if (p.x + p.w < x0 || p.x > x1 || p.y + p.h < y0 || p.y > y1) continue;
    out.push(p);
  }
  return out;
}
