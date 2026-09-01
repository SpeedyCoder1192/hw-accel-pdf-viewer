// pdf.js needs cmaps (CJK encodings) and standard_fonts (Type1 substitutes)
// available over HTTP. Copy them into public/ so they work in dev and build.
import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'node_modules/pdfjs-dist');
const to = resolve(root, 'public/pdfjs');

const exists = (p) => stat(p).then(() => true, () => false);

if (!(await exists(from))) {
  console.error('pdfjs-dist not installed; run npm install first.');
  process.exit(1);
}

await mkdir(to, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts']) {
  await cp(resolve(from, dir), resolve(to, dir), { recursive: true });
}
console.log('copied pdf.js cmaps + standard_fonts -> public/pdfjs');
