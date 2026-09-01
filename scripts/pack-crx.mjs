// Signs dist/ into a crx.
//
// Chrome and Edge can both do this with --pack-extension, so there is no reason
// to hand roll CRX3 signing. The key matters more than the crx: it decides the
// extension id, so it gets reused whenever it already exists, otherwise every
// build would look like a brand new extension to the browser.

import { execFile } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const NAME = 'gpu-pdf-viewer';
const crx = join(root, `${NAME}.crx`);
const pem = join(root, `${NAME}.pem`);

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('No Chrome or Edge found. Set CHROME_PATH to the binary and try again.');
  process.exit(1);
}
if (!existsSync(dist)) {
  console.error('dist/ is missing. Run npm run build first.');
  process.exit(1);
}

const args = [`--pack-extension=${dist}`, '--no-message-box'];
if (existsSync(pem)) args.push(`--pack-extension-key=${pem}`);

await run(browser, args).catch((err) => {
  // The packer reports problems on stderr and still exits non-zero on Windows
  // even when it worked, so the real check is whether the file appeared.
  if (!existsSync(join(root, 'dist.crx'))) throw err;
});

if (!existsSync(join(root, 'dist.crx'))) {
  console.error('Packing produced no crx. Try running the browser command by hand to see why.');
  process.exit(1);
}

rmSync(crx, { force: true });
renameSync(join(root, 'dist.crx'), crx);
if (existsSync(join(root, 'dist.pem'))) renameSync(join(root, 'dist.pem'), pem);

console.log(`packed ${NAME}.crx with ${browser}`);
console.log(`key is ${NAME}.pem, keep it, it decides the extension id`);
