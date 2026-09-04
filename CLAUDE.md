# ScribblePDF — Chrome MV3 Extension

> Directory is still `pdf-annotator/`; the product name is **ScribblePDF**.

Client-side PDF editing and annotation in a browser tab. **Zero server, local-first.**
No PDF byte ever leaves the tab.

> Keep this file current. It is the entry point for future sessions — read it
> before re-reading the codebase.

---

## 1. Status

**Phase 1 (Local MVP) — complete and verified.**

| Capability | State | Notes |
|---|---|---|
| MV3 boilerplate, build, icons | done | esbuild, no framework |
| pdf.js rendering (lazy, HiDPI, zoom) | done | verified to 3 pages incl. `/Rotate 90` |
| Floating toolbar (drag, tools, styles) | done | Text / Check / Cross / Signature / Download |
| Text tool with in-place editing | done | contenteditable, live font controls |
| Check + cross stamps | done | shared unit glyph, screen == export |
| Signature: draw, save, reuse, resize | done | `chrome.storage.local`, trimmed PNG |
| Export via pdf-lib (burn-in) | done | round-trip verified on rotated pages |
| Hebrew text: real embedded font | done | Noto Sans Hebrew + fontkit, selectable |
| Bidirectional (RTL/LTR) layout | done | full UBA via bidi-js, unit-tested |
| Other scripts (Arabic/CJK) | raster fallback | see §6 |
| Undo/redo, keyboard shortcuts | done | drag collapses to one undo step |
| Prefs persistence | done | debounced writes |
| Toolbar matching design reference | done | segmented tiles, glyph over label |
| Exporter code-split | done | 363 KB initial vs 1.7 MB bundled |
| Exit editor (back to source PDF) | done | routed via the worker to dodge auto-open |
| Optional per-site host permissions | done | no site access at install |
| Runtime font metrics | done | fixes cross-platform baseline drift |

**Phase 2 (in progress): Chrome Web Store readiness.** The task list
lives in `.claude/context.json` under `phase_2_tasks`, prioritised, each with
the files it touches and an acceptance criterion. Phase 1 was smoke-tested in a
real unpacked install by the owner on 2026-08-31.

**Landed:** the permissions cluster (`optional_host_permissions`, `activeTab`,
narrowed WAR, per-origin session redirect rules) and runtime font metrics.
Outstanding: store assets, privacy policy, packaging, QA matrix, and
`p2-verify-in-real-extension` — the harness shims `chrome.*`, so the grant and
exit flows are only proven end to end once loaded unpacked.

---

## 2. Two hosts, one core

ScribblePDF builds for two targets from the same source:

| Target | Command | Output |
|---|---|---|
| Chrome MV3 extension | `npm run build` | `dist/` (then `npm run package` → `releases/`) |
| Web / installable PWA | `npm run build:web` | `dist-web/` |

`src/core` is host-agnostic and `src/ui` is DOM-only; both run unchanged in
either host. Core was coupled to Chrome in exactly two ways — asset URLs and
key-value storage — and both now sit behind `core/platform.ts`. A host installs
its adapter with `setPlatform()` before touching core.

**Core imports no adapter.** The import direction is what enforces the rule, so
a `chrome.*` reference cannot drift back in; `src/core` must stay at zero.

## 3. Architecture decisions (and why)

### Normalized view space is the single coordinate system
Annotations store `x`/`y` as fractions (0..1) of the rendered page box, with the
page's `/Rotate` already applied. Sizes are fractions of page height.

- Zoom-independent: `px = x * canvas.width`. No rescaling pass, ever.
- Rotation-agnostic: the annotation lands where the user *saw* it.
- HiDPI backing stores never leak into stored data.

The **only** crossing into PDF user space is at export, through pdf.js's
`viewport.convertToPdfPoint()` (`src/core/geometry.ts`). That handles `/Rotate`,
non-zero `/MediaBox` origins and the y-flip for free. Do not reimplement the
rotation matrix anywhere else.

The view→user basis (`basisOf`) is derived *empirically* from the viewport by
converting three points. Text rotation falls out as `atan2` of the right vector.

### Export edits the original bytes
`pdf-lib` loads the pristine source and appends content to each page. The
exported file keeps its real text layer, vectors, bookmarks and file size. We
never re-encode pdf.js's raster output.

`PdfRenderer` keeps `originalBytes` as a private copy because **pdf.js detaches
the ArrayBuffer it is handed**.

### Check/cross are polylines, not glyphs
`GLYPHS` in `geometry.ts` is a unit-box polyline consumed by *both* the on-screen
SVG renderer and the pdf-lib exporter. Each vertex is converted individually, so
marks need no rotation math and the preview cannot drift from the output.

### Hebrew is embedded, not rasterized — and bidi is resolved by us
PDF has no notion of text direction: glyphs are painted in the order and at the
positions given. So `core/bidi-layout.ts` resolves one logical line into
paint-order spans, using the Unicode Bidi Algorithm (bidi-js) for direction and
font coverage for the font split.

Two facts drive the design:

- **Noto Sans Hebrew is Hebrew-only** — 148 code points, no Latin, no digits,
  no ASCII punctuation. `ע"י` (with a typed `"`) therefore needs *two* fonts on
  one line. Runs are split by coverage; characters both fonts cover (spaces)
  follow the surrounding span rather than fragmenting words.
- **fontkit reverses RTL spans itself.** Hebrew spans must be handed to
  `drawText` in LOGICAL order. Neutral characters inside an RTL run drawn with a
  Latin font get no such treatment and must be reversed and mirrored by us.
  Getting this backwards double-reverses the text and is invisible until you
  look at rendered output — `scripts/test-bidi.mjs` pins it against bidi-js's
  own reference reordering.

Base direction is `auto` (first strong character) on **both** sides: `dir="auto"`
on the on-screen element and `getEmbeddingLevels(line, 'auto')` in the exporter.
They must agree, or a mixed line lands in a different order on paper.

### The exporter is loaded lazily
pdf-lib + fontkit + bidi-js are ~1.3 MB and none of it is needed to render a
page, so `main.ts` reaches them through `import('@/core/exporter')` on first
export. Shared text metrics live in `core/text-style.ts` precisely so the
annotation layer does not drag the exporter into the initial chunk. Initial
parse is 363 KB instead of 1.7 MB.

### No host access at install; sites are granted one at a time
The extension declares no `host_permissions`. `openUrl()` gates on
`permissions.contains()` and, on a miss, renders an "Allow `<host>`" button in
the empty state. `permissions.request()` **must** be called directly from that
click handler — a user gesture is required, and the auto-open redirect path has
none at all, which is why the prompt lives in the viewer rather than the worker.

Redirect rules follow from what was granted: they are rebuilt from
`permissions.getAll()` and re-synced on `permissions.onAdded/onRemoved`. They
are **session-scoped, not dynamic**, because `excludedTabIds` is session-only —
and that is what makes "Exit editor" possible.

### Local files are read by the worker and handed over via IndexedDB
`viewer.html?file=file:///…` cannot work. Chrome blocks `file://` *subresource*
loads from any document ("Not allowed to load local resource"), and that
renderer check runs **before** extension permissions are consulted — so no grant
fixes it. A service worker is not a document, so it reads the file and stages
the bytes.

Transport is IndexedDB (`core/handoff.ts`), because the obvious routes are all
wrong: `chrome.runtime.sendMessage` JSON-serialises (an `ArrayBuffer` arrives as
`{}`), `URL.createObjectURL` does not exist in a service worker, and
`chrome.storage.local` is 10 MB of JSON. Records are **single-use** —
`takeHandoff` reads and deletes in one transaction — with a 5-minute TTL and a
startup sweep for tabs closed before the viewer ran.

Routing: `?token=` local, `?file=` remote, `?reason=file-access` when the toggle
is off. Note `file://` access **cannot be requested at runtime**;
`host_permissions: ["file:///*"]` only makes the toggle available, and it is off
by default and grants no site access.

### The review prompt reveals itself synchronously
`ui/review-toast.ts` deliberately does **not** use `requestAnimationFrame` to
add its reveal class. rAF is throttled, and does not run at all in a
backgrounded tab — which left the toast permanently at `opacity: 0` with the
class never applied. It positions and reveals in the same tick, forcing the
style flush the transition needs by reading `offsetHeight`.

It also keeps clear of the floating toolbar by *measuring* it, not by a CSS
breakpoint: the toolbar is centred **and** draggable, so whether they collide
depends on where the user left it. The measurement uses the layout box
(`offsetWidth`/`offsetHeight` plus computed insets) rather than
`getBoundingClientRect`, because the entry transform skews a rect reading
depending on which frame it lands in.

Eligibility lives apart in `core/review.ts` (`pdfSaveCount`,
`hasPromptedForReview`) so the rule is testable on its own.

### Keeping the extensions card free of errors
`chrome://extensions` collects uncaught exceptions, unhandled promise rejections
and `console.error` — but **not** `console.warn`. So every recoverable condition
(a tab closed mid-flight, a rule update racing a permission change, file access
switched off) is warned, and `console.error` is reserved for genuine failures
that should surface. Worker listeners run through `guard()` so an async body can
never leak a rejection.

The viewer refuses to `fetch()` or navigate to any non-http(s) URL. A document
cannot load `file://`, and attempting it throws a `TypeError` that lands on the
extension card — so `openUrl()` rejects other schemes up front rather than
discovering it at the network layer.

### Exit editor goes through the service worker
Setting `location.href` back to the PDF would be caught by our own redirect rule
and bounce straight back into the editor. So the viewer sends `exitEditor` to
the worker, which adds the tab to a bypass list (persisted in
`chrome.storage.session`, because the worker can be killed mid-flight), rebuilds
the rule, and only then navigates. The bypass clears on `tabs.onUpdated`
(`status === 'complete'`) — event-driven rather than a timer, which an MV3
worker cannot be trusted to keep alive.

### Vanilla TS + esbuild, no framework
One writer (the viewer), a few readers. A ~130-line observable store beats a
framework here: smaller bundle, faster injection, and a shipped bundle a Web
Store reviewer can actually read.

### PDF interception is opt-in
Hijacking every `.pdf` navigation by default is hostile and invites review
scrutiny. The redirect rule exists only while `prefs.autoOpen` is true *and*
the site's origin has been granted. The default path is the toolbar button.

---

## 4. File map

```
manifest.json            MV3 manifest (CSP, permissions, web-accessible viewer)
build.mjs                esbuild bundle + asset copy; --watch, --dev
scripts/make-icons.mjs   rasterises assets/*.svg -> public/icons/*.png (resvg)
scripts/make-sample-pdf.mjs  dev/sample.pdf fixture (page 3 is rotated 90°)
scripts/serve.mjs        static server for the dev harness only
scripts/test-bidi.mjs    bidi/font-split regression suite (npm test)

public/fonts/            Noto Sans Hebrew Regular + Bold (OFL, see OFL.txt)
assets/                  icon artwork, design source of truth (NOT shipped)
                           icon.svg        full detail, drives 128px
                           icon-small.svg  simplified, drives 16/32/48px

src/
  core/
    types.ts          annotation model + COORDINATE SYSTEM contract — read first
    geometry.ts       view<->PDF conversion, basis, unit glyphs, colour
    text-style.ts     LINE_HEIGHT, MEASURED font metrics, CSS stacks (dependency-free)
    messages.ts       viewer <-> service worker message shapes
    handoff.ts        single-use IndexedDB handoff for local (file://) PDFs
    review.ts         review-prompt eligibility + the store review URL
    bidi-layout.ts    UBA reordering + font-coverage run splitting (pure)
    store.ts          observable state, undo/redo, transient drag commits
    pdf-renderer.ts   pdf.js: lazy render, zoom, render-task lifecycle
    exporter.ts       pdf-lib burn-in, font metrics, Unicode raster fallback
    storage.ts        chrome.storage.local: prefs + signature library
  ui/
    toolbar.ts        floating toolbar, draggable, contextual style row
    annotation-layer.ts  placement, selection, drag, resize, text editing
    signature-modal.ts   drawing canvas, smoothing, ink-bbox trim, library
    review-toast.ts      one-time store review prompt
    icons.ts          inline SVG
  platform/
    extension.ts      chrome.runtime.getURL + chrome.storage.local
    web.ts            baseURI-relative assets + IndexedDB
  viewer/main.ts      EXTENSION entry: wiring, shortcuts, export, file input
  web/main.ts         WEB entry: touch, pinch zoom, service worker registration
  background/service-worker.ts  action click + opt-in DNR redirect

public/viewer/        viewer.html + viewer.css (shared stylesheet)
public/web/           index.html, mobile.css, manifest.webmanifest, sw.js
dev/shim.js           chrome.* shim for the harness (permissions, storage, runtime)
                      the harness HTML is GENERATED from viewer.html at dev build
                      time — do not hand-write a second copy, it goes stale
```

## 5. State design

`Store` (`src/core/store.ts`) holds one `State`:

- `tool`, `selectedId`, `editingId` — UI state, not undoable.
- `annotations: Annotation[]` — the document; every mutation goes through
  `commit()`, which pushes to the undo stack (limit 100) and clears redo.
- `updateTransient()` rewrites the last history entry, so a 200-frame drag
  collapses into **one** undo step. Pass `first: true` on the first frame only.
- `pendingSignature` — chosen in the modal, consumed by the next page click.
- `dirty` — drives the export button glow and the `beforeunload` guard.

Subscribers get the whole state and diff what they need. The annotation layer
diffs DOM nodes **by id** — a full rebuild would destroy the caret mid-typing.

## 6. Build and run

```bash
npm install
npm run build        # → dist/   (load unpacked in chrome://extensions)
npm run dev          # watch mode
npm run typecheck
npm test             # bidi + font-coverage regression suite
npm run check        # typecheck + test
npm run build:web    # → dist-web/  (web + PWA target)
npm run icons        # regenerate PNG icons from assets/*.svg
npm run package      # store-ready zip in releases/ (refuses on dev artefacts)
```

Store materials: `store/LISTING.md` (listing copy, permission justifications,
data disclosures) and `docs/index.md` (the privacy policy — named `index` so
GitHub Pages serves it at the site root).

Load `dist/` via `chrome://extensions` → Developer mode → **Load unpacked**.
Open any PDF and click the extension's toolbar icon, or open the viewer and
drop a file onto it.

**Dev harness** (drive the real bundle without installing the extension):
```bash
node scripts/make-sample-pdf.mjs
node build.mjs --dev
node scripts/serve.mjs 5273
# → http://localhost:5273/viewer/harness.html?file=/dev/sample.pdf
```

**Web/PWA locally** (localhost is a secure context, so the service worker
behaves exactly as it will on Pages):
```bash
npm run build:web
node scripts/serve-web.mjs 5274   # → http://localhost:5274/
```
When iterating, remember the service worker will serve its own cache: the cache
name embeds a content hash so a rebuild busts it, but an *unchanged* rebuild
will legitimately keep serving the old bytes.
`__DEV__` gates a `window.__paDev` hook (`store`, `renderer`, `exportBase64()`,
`exportAndReload()`). It is dead-code-eliminated from production — verify with
`grep -c __paDev dist/viewer/main.js` → `0`.

## 7. Known limitations / traps

1. **Script coverage is tiered.** Latin-1 uses the standard PDF fonts; Hebrew
   uses embedded, subsetted Noto Sans Hebrew (real selectable text). Anything
   outside both — Arabic, CJK, emoji — still falls back to a 4x PNG raster,
   which looks right but is **not selectable**. Adding a script means shipping
   another face and extending `classify()` in `exporter.ts`.

   Related: copy-paste out of the exported PDF returns *visual* order for
   Hebrew, because PDF stores paint order and we emit no `/ActualText` marked
   content (pdf-lib has no API for it). Rendering and selection are correct;
   only the clipboard order of an RTL run may look reversed in some readers.

2. **`RenderTask.cancel()` is asynchronous.** Starting a new render on the same
   canvas before the cancelled task settles makes pdf.js hang *both* promises.
   `PdfRenderer.cancelTask()` awaits the rejection. Never cancel-then-render
   without awaiting — this deadlocked the viewer during development.

3. **pdf.js detaches the ArrayBuffer** passed to `getDocument`. Always copy.

4. **Font metrics are measured, never assumed.** `core/text-style.ts` reads
   `TextMetrics.fontBoundingBoxAscent/Descent` for the font the browser actually
   resolved, because `"Helvetica"` becomes Arial on Windows and Liberation Sans
   or DejaVu Sans on Linux. The hardcoded table survives only as a fallback.
   `warmUpFontMetrics()` must run before anything calls `baselineRatio` — the
   `@font-face` Hebrew file loads lazily, and measuring too early caches the
   fallback font's metrics.

   With a fixed `line-height` the browser centres the content area using the
   *max* ascent/descent of the fonts on that line, which is why `baselineRatio`
   takes a `hebrew` flag.

   The `@font-face` in `viewer.css` is load-bearing for the same reason: it
   pins the on-screen Hebrew face to the one the exporter embeds, instead of
   whatever Hebrew font the OS happens to supply.

5. **DNR redirect skips query strings.** `regexSubstitution` splices the matched
   URL in raw, so a `&` in the source would split our own `file=` parameter. The
   rule matches `^https?://[^?#]+\.pdf$` only; `main.ts` sniffs which producer
   wrote the parameter before decoding.

6. **No host access is declared.** Reading a remote PDF needs the user to grant
   its origin from the viewer's "Allow `<host>`" button.
   `chrome.permissions.request()` must be called *directly* from that click or
   the user gesture is lost — do not move it into the service worker or behind
   an `await`.

   **Chrome keeps granted optional host permissions across an unpacked reload**
   (the extension ID is stable), so an install that once declared `<all_urls>`
   keeps showing "On all sites" long after the declaration is gone.
   `revokeLegacyBroadHostGrants()` clears that **once**, on `onInstalled` —
   deliberately not on every startup, because the chrome://extensions dropdown
   lets a user choose "On all sites" for themselves and revoking repeatedly
   would fight them. The definitive reset is to remove and re-add the unpacked
   extension.

7. **`file://` PDFs** are read by the service worker, never by the viewer — see
   the handoff section in §2. They still need the per-extension "Allow access to
   file URLs" toggle, which is off by default and cannot be requested
   programmatically; when it is off the worker routes to
   `?reason=file-access` and the viewer explains the toggle. Drag-and-drop and
   "Choose PDF" need no permission at all and always work.

   A handoff token is consumed on load, so **reloading a local-file tab will not
   re-open it** — that is deliberate, so the bytes do not outlive the load.

8. **Bundle weight:** the package is 6.4 MB, dominated by `vendor/cmaps`
   (1.6 MB) and `vendor/standard_fonts` (1.0 MB) — both only needed for CJK and
   documents with non-embedded fonts. JavaScript is already split: 363 KB
   initial, 1.3 MB exporter chunk on demand. Phase 2 could trim the cmaps.

## 8. Toolbar design

The primary row follows the supplied design reference: a single framed slab of
tiles, each a bold glyph over a caption, divided by light hairlines. Glyph
weights are matched to it — the `A` is a real serif letterform (a stroked
triangle never reads as one), the check and cross are heavy strokes, the
signature is a cursive `n` with a looped entry and swash tail.

Two states the reference did not cover: the **active tool** is an accent tint
plus an inset underline, while **Download** keeps the solid accent fill, so the
primary action stays visually unique. Secondary controls (select, undo/redo,
zoom, open) and the contextual style controls sit on a quieter second row.

Tiles are toggles — clicking the active tool returns to Select.

## 9. Icon artwork

`assets/icon.svg` and `assets/icon-small.svg` are the source of truth;
`npm run icons` rasterises them into `public/icons/` with `@resvg/resvg-js`
(a devDependency — it never reaches the shipped extension).

**Two artworks, not one scaled.** The pen, document fold and signature loop are
sub-pixel noise below ~64px, so 16/32/48 use the simplified drawing (card, heavy
check, one scribble stroke) and only 128 gets the full composition. Downsampling
the full artwork to 16px produces mud.

**The ink colour is not the literal spec.** The brief asked for `#32CD32` on
`#FF7F50`; that pairing is 1.17:1 contrast and effectively invisible. The
supplied reference image itself uses a much lighter yellow-green, so the ink is
`#C6F03B` (1.9:1). Both SVGs carry this note; changing two fill/stroke values
reverts it.

**Trap:** a `--` sequence inside an XML comment makes an SVG fail to parse, and
the failure is silent in an `<img>` tag. `make-icons.mjs` asserts against it.

## 10. Verification performed

Driven through the dev harness in a real browser:

- 3-page fixture renders; fit-to-width correct; `/Rotate 90` page correct.
- Text, check, cross, signature placed by real clicks; positions match
  expectation to <1%.
- Export → reopen the exported bytes → annotations appear **burned into the
  PDF** at identical positions on both upright and rotated pages.
- 20 rapid zoom clicks: no deadlock, all pages re-rasterize.
- Production build contains zero dev-hook references, in every chunk.

Hebrew, added in this phase:

- `npm test` — 12 bidi cases (pure Hebrew, gershayim, mixed Hebrew/Latin/digits,
  brackets, Hebrew punctuation, leading/trailing spaces) checked against
  bidi-js's own reference reordering, plus an assertion that no span contains a
  character its font cannot render.
- Six Hebrew annotations exported and reopened: text layer extraction returns
  real Hebrew (`אושר ונבדק`, `חשבונית מס`), confirming embedded text rather than
  raster. Output shrank 17 KB → 11.8 KB versus the raster path.
- Bold Hebrew resolves to the Bold face.
- Mixed `אושר ע"י ברק — OK 42` renders identically on screen and on paper,
  including on the `/Rotate 90` page.
- Exporter chunk fetched exactly once, on first export.
