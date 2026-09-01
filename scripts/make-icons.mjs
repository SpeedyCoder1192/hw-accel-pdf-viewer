// Generates the extension's PNG icons.
//
// Action icons have to be raster, and pulling in an image library for four tiny
// squares is silly, so this writes the PNGs by hand: RGBA rows, zlib, three
// chunks. Shapes are supersampled 3x3 for antialiasing.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];

const BG = [0xe0, 0x4b, 0x3a];
const FG = [0xff, 0xff, 0xff];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of the rounded-square badge and the page glyph at a unit point. */
function sample(u, v) {
  const r = 0.22;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  const inBadge = Math.hypot(dx, dy) <= r;
  if (!inBadge) return null;

  const x0 = 0.3;
  const x1 = 0.72;
  const y0 = 0.22;
  const y1 = 0.78;
  const fold = 0.17;
  const inRect = u >= x0 && u <= x1 && v >= y0 && v <= y1;
  const foldedCorner = x1 - u + (v - y0) < fold; // clipped triangle, top right
  return inRect && !foldedCorner ? FG : BG;
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const cov = a / (255 * n);
      rgba[i] = cov ? Math.round(r / (a / 255)) : 0;
      rgba[i + 1] = cov ? Math.round(g / (a / 255)) : 0;
      rgba[i + 2] = cov ? Math.round(b / (a / 255)) : 0;
      rgba[i + 3] = Math.round(cov * 255);
    }
  }
  writeFileSync(join(OUT, `icon${size}.png`), png(size, rgba));
}

console.log(`icons: wrote ${SIZES.length} PNGs to extension/icons`);
