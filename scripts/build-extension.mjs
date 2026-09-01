// Post-build step: turns dist/ into a loadable unpacked extension.
//
// Vite emits the viewer page and its assets; this copies the MV3 glue beside
// them. background.js has no imports, so it is copied verbatim rather than
// bundled -- one less build artefact to reason about when debugging a service
// worker.

import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ext = join(root, 'extension');

if (!existsSync(join(dist, 'viewer.html'))) {
  console.error('dist/viewer.html is missing -- run the Vite build first.');
  process.exit(1);
}

// Keep the manifest version in step with package.json so there is one source.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

cpSync(join(ext, 'background.js'), join(dist, 'background.js'));
cpSync(join(ext, 'icons'), join(dist, 'icons'), { recursive: true });

// Source maps are large and of no use inside a shipped extension.
const stripMaps = process.argv.includes('--strip-maps');
if (stripMaps) {
  const { readdirSync, rmSync } = await import('node:fs');
  const assets = join(dist, 'assets');
  for (const name of readdirSync(assets)) {
    if (name.endsWith('.map')) rmSync(join(assets, name));
  }
}

console.log('extension: dist/ is ready to load unpacked');
