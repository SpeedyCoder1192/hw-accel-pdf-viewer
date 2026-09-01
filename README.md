# GPU PDF Viewer

A Chrome extension that takes over the browser's PDF viewer and replaces it with one that actually
uses your GPU. Pages get rasterized on worker threads and every pixel on screen is drawn by WebGL2.
No 2D canvas being stretched with CSS, which is what most "fast" web PDF viewers really do.

Built on [PDF.js](https://mozilla.github.io/pdf.js/).

## Try it

```
npm install
npm run build
```

That gives you a `dist/` folder. Go to `chrome://extensions`, flip on **Developer mode**, hit
**Load unpacked**, and pick `dist`. Now open any PDF and it lands here instead of Chrome's viewer.

A few notes:

- For local files, tick **Allow access to file URLs** on the extension's details page. Chrome hides
  local files from extensions until you do.
- The toolbar button opens an empty viewer you can drop a file onto.
- Want Chrome's viewer back for a bit? The overflow menu has **Open PDF links here**, which flips the
  takeover off and on without uninstalling anything.

If you just want to hack on it, `npm run dev` serves the same viewer as a normal page at
<http://localhost:5273/viewer.html>. Everything works there except the PDF takeover, since that
needs the extension bits.

## Making a crx

```
npm run pack
```

That signs `dist/` into `gpu-pdf-viewer.crx` and, the first time, writes `gpu-pdf-viewer.pem` next
to it. Keep that pem. It is the private key that decides the extension id, so reusing it means every
later crx is an update rather than a whole new extension. It is gitignored on purpose, do not commit
it or hand it out.

Heads up, Chrome refuses to install crx files that did not come from a store, so this is only useful
if you have enterprise policy set up or you are handing the file to something that does. For normal
use, load `dist` unpacked.

## Why it is actually fast

Most web PDF viewers render a page into a 2D canvas and then scale that canvas with CSS. The GPU
only copies the result, your main thread does all the real work, and zooming either goes blurry or
stutters. This one flips that around.

- **The compositor is WebGL2** (`src/gl/renderer.js`). Page backgrounds, tiles and drop shadows are
  all GPU draw calls through one textured quad program. The shadows are a signed distance field in
  the fragment shader, so they cost no CPU time and no extra texture memory.
- **Rasterizing happens off the main thread.** `src/raster/raster.worker.js` parses *and* rasterizes.
  It imports `pdf.worker.mjs` and hangs it off `globalThis.pdfjsWorker`, which makes PDF.js parse
  inline instead of spawning a nested worker, so each raster worker is exactly one OS thread doing
  both jobs. Pages get drawn into an `OffscreenCanvas` and come back as a transferable `ImageBitmap`
  that goes straight into `texImage2D`. The main thread never touches a pixel.
- **The camera never waits on anything.** Panning and zooming only rewrite uniforms. Nothing in the
  input path awaits a rasterizer, so gestures stay smooth no matter how far behind the workers are.
- **Tiles, LODs, mipmaps.** Pages get cut into 512 device pixel tiles at half octave scale levels.
  When you zoom, whatever coarser tiles are already in memory get painted underneath, so you never
  see a blank flash. It just sharpens up. Textures are mipmapped with anisotropic filtering so
  zooming out does not alias.
- **VRAM has a budget.** `src/gl/tilecache.js` is an LRU with a byte limit, 384 MB by default. A
  texture used in the current frame can never be evicted out from under it.
- **Stale work gets dropped.** Every frame works out which tiles it wants and cancels every queued
  job outside that set, so fast scrolling never builds up a backlog.

Hit **⇧I** (or use the overflow menu) for a stats overlay with fps, draw calls, live textures, VRAM,
queue depth and your GPU name, so you can check all of the above is real on your machine.

## What it does

- Takes over PDF links. You can also open files with the picker, drag and drop, a pasted URL, or
  `?file=`
- `#page=`, `#nameddest=` and `#zoom=` deep links
- Password protected files
- Continuous scroll, smooth inertial panning, zoom at the cursor with Ctrl and the wheel, pinch zoom
- Fit width, fit page, fit height, actual size, and preset zooms from 10% to 1200%
- Page box, prev and next, thumbnails, outline, internal links
- Rotation, single page, book spread and two up layouts
- Text selection and copy, right on top of the GPU canvas
- Find across the whole document with a match count, highlight all, next and previous
- Thumbnail sidebar and an outline tree
- Links, both internal and external
- Print at 150 DPI, and download the original bytes
- Dark mode for the interface. Page colors are left exactly as the document made them
- Fullscreen and presentation mode
- Document properties
- Keyboard shortcuts for everything, press **?** to see them

## Keyboard

The whole thing is keyboard first. Nothing needs the mouse, focus is always visible, and `Esc`
always hands the keyboard back to the document.

| Key | What it does |
| --- | --- |
| `↑ ↓ ← →`, `J` / `K` | Scroll |
| `D` / `U` | Half a screen down or up |
| `Space` / `⇧Space` | A screen down or up |
| `PgUp` / `PgDn` | Previous or next page |
| `Home` / `End` / `⇧G` | First or last page |
| `G` | Go to a page, jumps into the page box |
| `+` / `−` | Zoom in or out |
| `0` / `1` / `2` / `3` | Actual size, fit width, fit page, fit height |
| `Ctrl` + wheel | Zoom at the cursor |
| `Space` + drag | Pan |
| `/` or `Ctrl+F` | Find |
| `N` / `⇧N`, `Enter` / `⇧Enter` | Next or previous match |
| `R` / `⇧R` | Rotate |
| `S` `⇧D` `H` `P` | Sidebar, dark mode, pan tool, presentation |
| `⇧I` | Stats overlay |
| `Ctrl+O` / `Ctrl+P` / `Ctrl+S` | Open, print, download |
| `?` | The shortcut list |
| `Esc` | Close find, leave presentation, get focus back on the document |

## How the takeover works

MV3 killed blocking `webRequest`, so this uses `declarativeNetRequest` redirect rules. They get
installed at runtime by the service worker rather than shipped as a static file, because the
redirect target has to contain the extension's own id and that only exists once it is installed.

1. **URL rule.** Any main frame navigation to something ending in `.pdf` goes to
   `viewer.html?file=<url>`.
2. **Content type rule.** Any main frame response with `Content-Type: application/pdf` goes there
   too, which catches `/download?id=123` style links. This one needs Chrome 128 or newer. On older
   versions the service worker logs a warning and installs only the first rule. Anything marked
   `Content-Disposition: attachment` is left alone, so downloads stay downloads.

The viewer then fetches the file itself with `credentials: 'include'`, so PDFs behind a login still
work. DNR cannot percent encode its substitution, so `?file=` is read as the raw tail of the query
instead of a normal parameter. That way a PDF URL with its own query string survives, and so does a
`#page=12` fragment, which gets applied once the file loads.

That handoff is one URL rewrite deep and easy to lose, so there is a backup. The service worker also
notes each tab's PDF navigation, and a viewer that opens without a usable `?file=` just asks what
its tab was opening. If it still cannot load the file it says so and offers a retry, instead of
dumping you back on an empty file picker.

Local files go through `XMLHttpRequest`, because `fetch` refuses the `file:` scheme.

## Layout of the code

```
extension/manifest.json      MV3 manifest, declarativeNetRequest + webRequest + <all_urls>
extension/background.js      service worker, redirect rules and per tab URL recovery
viewer.html                  the extension page, also the dev server page
src/
  gl/renderer.js             WebGL2 compositor, textured quads and SDF shadows
  gl/tilecache.js            LRU over GL textures with a VRAM budget
  raster/raster.worker.js    parses and rasterizes into OffscreenCanvas, hands back ImageBitmap
  raster/pool.js             worker pool with a re-sortable priority queue
  layout.js                  page layout in PDF points, spreads, visibility
  viewer.js                  camera, tile scheduling, frame loop, input, print
  textlayer.js               per page DOM overlays for text, links and highlights
  search.js                  streaming find across the document
  sidebar.js                 thumbnails and outline
  main.js                    toolbar, findbar, dialogs, keyboard, HUD, URL loading
scripts/                     PDF.js asset copy, icon generation, extension packaging
```

Layout lives in PDF points, so zooming is purely a camera change. No rectangle gets recomputed and
nothing reflows. Text selection and search need real DOM though, so every visible page also gets a
transparent overlay built once at `--scale-factor: 1` and moved with a single CSS transform. Zooming
costs one style write per visible page instead of relaying out thousands of spans. Search hits get
mapped back through the text layer's item offsets into `Range` rectangles, stored in document units
so highlights stay put when you zoom later.

Page sizes get discovered progressively. Page one's size is assumed for the whole file so the first
frame is instant, then the odd sizes get corrected in the background with a relayout that keeps your
position.

MV3 bans `eval`, so both parses run with `isEvalSupported: false` and the workers are real bundled
files rather than blob URLs.

PDF.js assumes a DOM in a few spots, so the raster worker works around it. `useWorkerFetch: true`
because the default decision reads a bare `document.baseURI`, `disableFontFace: true` so glyphs get
drawn as paths instead of going through `document.fonts`, an `OffscreenCanvas` backed canvas factory
for the scratch canvases that transparency groups need, and a stub filter factory, which is the same
fallback PDF.js itself uses when there is no document.

## What it does not do

**No form filling and no annotation editing.** Form fields and annotations still show up, because
PDF.js draws them into the rasterized page, but they are pixels rather than widgets so you cannot
click into them. Making that work means rebuilding PDF.js's annotation layer and editor stack on top
of the GPU compositor, which is a whole other project.

Also missing: signature checking, XFA forms, accessibility structure trees.

One rendering caveat. SVG filters need a document, so luminosity soft masks and `/TR` transfer
functions do not get applied while rasterizing. Normal soft masks are composited in JavaScript by
PDF.js and are fine, but a page leaning on those two features can look slightly off.

## Requirements

Chrome or Edge 116 and up, 128 and up if you want the content type rule. Firefox needs the changes
mentioned above. The viewer needs WebGL2, `OffscreenCanvas` and module workers. If the GPU context
gets lost it tells you instead of quietly falling back to software.

## License

MIT.
