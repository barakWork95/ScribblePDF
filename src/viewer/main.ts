/**
 * Viewer entry point — wires renderer, toolbar, annotation layer and export.
 *
 * PRIVACY INVARIANT: the only network request this application ever makes is
 * the one that fetches the PDF the user asked to open. Nothing is uploaded,
 * no analytics, no remote fonts, no CDN. Enforced by the CSP in manifest.json
 * (`script-src 'self'`) and by there being no fetch/XHR anywhere else.
 */
import { setPlatform } from '@/core/platform';
import { extensionPlatform } from '@/platform/extension';
import { PdfRenderer } from '@/core/pdf-renderer';
import { Store } from '@/core/store';
import { Toolbar } from '@/ui/toolbar';
import { AnnotationLayer } from '@/ui/annotation-layer';
import { SignatureModal } from '@/ui/signature-modal';
import { loadPrefs, savePrefs } from '@/core/storage';
import { clamp } from '@/core/geometry';
import { warmUpFontMetrics } from '@/core/text-style';
import type { ExitEditorRequest, ExitEditorResponse } from '@/core/messages';
import { takeHandoff } from '@/core/handoff';
import { markReviewPrompted, recordPdfSaved, shouldPromptForReview } from '@/core/review';
import { ReviewToast } from '@/ui/review-toast';

/**
 * The exporter pulls in pdf-lib, fontkit and bidi-js — roughly two thirds of
 * the app's JavaScript, and none of it is needed to render a page. Loading it
 * on first export keeps the initial parse (and therefore time-to-first-page)
 * down to pdf.js alone. esbuild emits it as a separate chunk.
 */
const loadExporter = () => import('@/core/exporter');

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
/** Horizontal breathing room left around the page at fit-to-width. */
const PAGE_GUTTER = 64;

const els = {
  root: document.getElementById('app') as HTMLDivElement,
  scroll: document.getElementById('scroll') as HTMLDivElement,
  pages: document.getElementById('pages') as HTMLDivElement,
  status: document.getElementById('status') as HTMLDivElement,
  empty: document.getElementById('empty') as HTMLDivElement,
  file: document.getElementById('file') as HTMLInputElement,
  title: document.getElementById('doc-title') as HTMLSpanElement,
  exit: document.getElementById('exit') as HTMLButtonElement,
  grant: document.getElementById('grant') as HTMLButtonElement,
  pick: document.getElementById('pick') as HTMLLabelElement,
  emptyTitle: document.getElementById('empty-title') as HTMLHeadingElement,
  emptyBody: document.getElementById('empty-body') as HTMLParagraphElement,
};

// Must precede any core call that resolves an asset or touches storage.
setPlatform(extensionPlatform);

const store = new Store();
const renderer = new PdfRenderer();
const layer = new AnnotationLayer(store);
const signatureModal = new SignatureModal();
const reviewToast = new ReviewToast();
let sourceName = 'document.pdf';
/** The document's own URL, when it came from one. Drives the exit button. */
let sourceUrl: string | null = null;

const toolbar = new Toolbar(store, {
  onExport: () => void doExport(),
  onSignature: () => void openSignature(),
  onOpenFile: () => els.file.click(),
  onZoom: (d) => void setZoom(renderer.getZoom() + d),
});

document.body.append(toolbar.el, signatureModal.el, reviewToast.el);

// --------------------------------------------------------------- bootstrap

async function main(): Promise<void> {
  store.set({ prefs: await loadPrefs() });
  persistPrefsOnChange();
  bindShortcuts();
  bindFileInputs();
  bindExit();
  // Must complete before anything measures the Hebrew face, or the cached
  // metrics come from a fallback font.
  await warmUpFontMetrics();

  const params = new URLSearchParams(location.search);

  // Local files arrive as a one-time IndexedDB token, never as a file:// URL:
  // a document cannot load file:// subresources at all. See core/handoff.ts.
  const token = params.get('token');
  if (token) {
    await openHandoff(token);
    return;
  }

  if (params.get('reason') === 'file-access') {
    showEmpty(
      'To open PDFs stored on your computer, switch on “Allow access to file URLs” ' +
        'for ScribblePDF in chrome://extensions. Or just choose the file below — ' +
        'that works without any permission.',
    );
    return;
  }

  const src = readSourceParam();
  if (!src) {
    showEmpty();
    return;
  }
  await openUrl(src);
}

/**
 * Collect a local PDF staged by the service worker.
 *
 * The record is single-use — `takeHandoff` deletes it in the same transaction
 * that reads it — so reloading this tab will not find it again. That is
 * deliberate: the bytes should not outlive the load.
 */
async function openHandoff(token: string): Promise<void> {
  setStatus('Loading PDF…');
  let record;
  try {
    record = await takeHandoff(token);
  } catch (err) {
    console.error('[scribblepdf] handoff read failed', err);
    showEmpty(`Could not read the staged file (${(err as Error).message}). Choose it below.`);
    return;
  }

  if (!record) {
    showEmpty(
      'That local file is no longer staged — a file handed over this way is ' +
        'read once and immediately discarded, so reloading this page cannot ' +
        'recover it. Open it again from the toolbar icon, or choose it below.',
    );
    return;
  }

  sourceName = record.name;
  sourceUrl = record.sourceUrl;
  els.exit.hidden = !record.sourceUrl;
  await openBytes(record.bytes);
}

/**
 * Origin match pattern for a URL, or null when it is not one we can request
 * (file:// access is a separate Chrome-level toggle, not an optional permission).
 */
function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url, location.href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

async function openUrl(url: string): Promise<void> {
  // NEVER fetch a non-http(s) URL from here. A document cannot load a file://
  // subresource: Chrome rejects it with "Not allowed to load local resource"
  // before extension permissions are consulted, and the resulting TypeError is
  // reported as an extension error in chrome://extensions. Local files arrive
  // through the worker's IndexedDB handoff (?token=) instead — this branch only
  // catches stale or hand-edited ?file=file:// links.
  if (!/^https?:/i.test(url)) {
    sourceUrl = null;
    els.exit.hidden = true;
    showEmpty(
      'Local files can’t be opened from this address. Open the PDF with the ' +
        'ScribblePDF toolbar icon, or choose it below — both work without any ' +
        'permission.',
    );
    return;
  }

  sourceUrl = url;
  els.exit.hidden = false;

  // The extension ships with no host permissions, so reading a remote PDF
  // needs the user to grant its origin first. permissions.request() requires a
  // user gesture, and a button click on this page is the only reliable one —
  // the auto-open redirect path has no gesture at all.
  const origin = originPattern(url);
  if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
    promptForAccess(url, origin);
    return;
  }

  setStatus('Loading PDF…');
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sourceName = filenameFromUrl(url);
    await openBytes(await res.arrayBuffer());
  } catch (err) {
    // file:// needs the per-extension "Allow access to file URLs" toggle, and
    // some servers refuse a cross-origin fetch even with host permissions.
    // Either way, the local file picker is a working way through.
    showEmpty(
      url.startsWith('file:')
        ? 'Chrome blocked reading that local file. Enable “Allow access to file URLs” for this extension, or open the file directly below.'
        : `Could not fetch that PDF (${(err as Error).message}). Open it from disk instead.`,
    );
  }
}

/** Offer a one-click grant for the site this PDF came from. */
function promptForAccess(url: string, origin: string): void {
  const host = new URL(url, location.href).hostname;
  showEmpty();
  els.emptyTitle.textContent = 'Allow access to this site';
  els.emptyBody.textContent =
    `ScribblePDF needs your permission to read PDFs from ${host}. ` +
    'It is asked for one site at a time, and the file still never leaves your browser.';
  els.grant.textContent = `Allow ${host}`;
  els.grant.hidden = false;
  setStatus('Permission needed');

  els.grant.onclick = () => {
    void (async () => {
      // Must be called directly from the click for the gesture to count.
      const granted = await chrome.permissions.request({ origins: [origin] });
      els.grant.hidden = true;
      els.grant.onclick = null;
      if (granted) {
        await openUrl(url);
      } else {
        showEmpty(`Without access to ${host}, open the file from your computer instead.`);
      }
    })();
  };
}

async function openBytes(bytes: ArrayBuffer): Promise<void> {
  setStatus('Rendering…');
  els.empty.hidden = true;
  els.root.classList.remove('is-empty');
  try {
    await renderer.load(bytes);
  } catch (err) {
    showEmpty(`This file could not be opened as a PDF (${(err as Error).message}).`);
    return;
  }
  // Lay out at 1:1 first — fit-to-width needs the real page dimensions, which
  // only exist once the shells are built.
  await renderer.layout(els.pages, 1);
  const fit = clamp(renderer.fitWidthZoom(els.scroll.clientWidth - PAGE_GUTTER), ZOOM_MIN, ZOOM_MAX);
  if (fit !== 1) await renderer.setZoom(fit);
  layer.attach(renderer.pageViews);
  els.title.textContent = sourceName;
  document.title = `${sourceName} — ScribblePDF`;
  setStatus(`${renderer.pageCount} page${renderer.pageCount === 1 ? '' : 's'}`);
  els.root.classList.add('is-ready');
}

// ------------------------------------------------------------------- zoom

let zoomPending: Promise<void> = Promise.resolve();

async function setZoom(next: number): Promise<void> {
  const z = clamp(Number(next.toFixed(2)), ZOOM_MIN, ZOOM_MAX);
  if (z === renderer.getZoom()) return;
  // Serialize zoom work: overlapping re-rasterizations fight over the canvases.
  zoomPending = zoomPending.then(async () => {
    await renderer.setZoom(z);
    layer.reflow();
    setStatus(`${Math.round(z * 100)}%`);
  });
  await zoomPending;
}

// ----------------------------------------------------------------- export

async function doExport(): Promise<void> {
  const { annotations } = store.get();
  toolbar.setExporting(true);
  setStatus('Writing PDF…');
  try {
    const { exportPdf, downloadBytes } = await loadExporter();
    const bytes = await exportPdf({
      originalBytes: renderer.getOriginalBytes(),
      annotations,
      viewports: renderer.pageViews.map((p) => p.baseViewport),
    });
    downloadBytes(bytes, sourceName.replace(/\.pdf$/i, '') + ' (annotated).pdf');
    store.markClean();
    setStatus(`Exported ${annotations.length} annotation${annotations.length === 1 ? '' : 's'}`);
    // Only successful exports count, and never let this path break the export.
    await recordPdfSaved().catch(() => undefined);
    void maybePromptForReview();
  } catch (err) {
    console.error('[scribblepdf] export failed', err);
    setStatus(`Export failed: ${(err as Error).message}`, true);
  } finally {
    toolbar.setExporting(false);
  }
}

// ----------------------------------------------------------------- review

/** Let the download settle before anything else asks for attention. */
const REVIEW_PROMPT_DELAY_MS = 1200;

/** Guards against a second export scheduling the toast while one is pending. */
let reviewPromptScheduled = false;

async function maybePromptForReview(): Promise<void> {
  if (reviewPromptScheduled || reviewToast.isVisible) return;
  try {
    if (!(await shouldPromptForReview())) return;
    reviewPromptScheduled = true;
    window.setTimeout(() => {
      reviewToast.show();
      // Set on display, so it is shown once per installation regardless of
      // whether the user acts on it.
      void markReviewPrompted().catch(() => undefined);
    }, REVIEW_PROMPT_DELAY_MS);
  } catch (err) {
    // A review nudge is never worth surfacing an error for.
    console.warn('[scribblepdf] review prompt check failed', err);
  }
}

// -------------------------------------------------------------- signature

async function openSignature(): Promise<void> {
  await signatureModal.open((pick) => {
    store.set({ pendingSignature: pick, tool: 'signature' });
    setStatus('Click on the page to place your signature');
  });
}

// ------------------------------------------------------------ exit editor

/**
 * Return the tab to the document it came from.
 *
 * Routed through the service worker rather than setting location directly: if
 * auto-open is enabled, the redirect rule would catch the navigation and bounce
 * straight back into the editor. The worker suppresses its own rule for this
 * tab first. If it cannot be reached, fall back to navigating anyway — worst
 * case with auto-open on, the user lands back here.
 */
function bindExit(): void {
  els.exit.addEventListener('click', () => {
    void (async () => {
      if (!sourceUrl) return;
      if (store.get().dirty && !confirm('Leave the editor? Your annotations will be discarded.')) {
        return;
      }
      // The guard would otherwise fire again during the navigation below.
      store.markClean();
      const request: ExitEditorRequest = { type: 'exitEditor', url: sourceUrl };
      try {
        const res = (await chrome.runtime.sendMessage(request)) as ExitEditorResponse | undefined;
        if (res?.ok) return;
      } catch {
        /* no service worker (dev harness) — fall through */
      }
      // The direct fallback only works for web URLs: a document cannot navigate
      // itself to file://, and attempting it logs an extension error.
      if (/^https?:/i.test(sourceUrl)) {
        location.href = sourceUrl;
      } else {
        setStatus('Could not reopen the original file — close this tab to leave.', true);
      }
    })();
  });
}

// ------------------------------------------------------------ file input

function bindFileInputs(): void {
  els.file.addEventListener('change', async () => {
    const f = els.file.files?.[0];
    if (!f) return;
    sourceName = f.name;
    sourceUrl = null;
    els.exit.hidden = true;
    await openBytes(await f.arrayBuffer());
    els.file.value = '';
  });

  const stop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  els.root.addEventListener('dragover', (e) => {
    stop(e);
    els.root.classList.add('is-dragover');
  });
  els.root.addEventListener('dragleave', (e) => {
    stop(e);
    els.root.classList.remove('is-dragover');
  });
  els.root.addEventListener('drop', async (e) => {
    stop(e);
    els.root.classList.remove('is-dragover');
    const f = e.dataTransfer?.files?.[0];
    if (!f || !/\.pdf$/i.test(f.name)) return;
    sourceName = f.name;
    sourceUrl = null;
    els.exit.hidden = true;
    await openBytes(await f.arrayBuffer());
  });
}

// ------------------------------------------------------------- shortcuts

function bindShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const editing = store.get().editingId !== null;

    if (e.key === 'Escape') {
      if (signatureModal.isOpen) signatureModal.close();
      else store.set({ tool: 'select', selectedId: null, editingId: null });
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void doExport();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
      return;
    }
    if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      void setZoom(renderer.getZoom() + 0.15);
      return;
    }
    if (mod && e.key === '-') {
      e.preventDefault();
      void setZoom(renderer.getZoom() - 0.15);
      return;
    }
    if (editing || mod) return;

    const map: Record<string, 'select' | 'text' | 'check' | 'cross' | 'signature'> = {
      v: 'select',
      t: 'text',
      c: 'check',
      x: 'cross',
      s: 'signature',
    };
    const tool = map[e.key.toLowerCase()];
    if (tool) {
      store.set({ tool, selectedId: null, editingId: null });
      if (tool === 'signature') void openSignature();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (!store.get().dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// ------------------------------------------------------------------ misc

function persistPrefsOnChange(): void {
  let last = JSON.stringify(store.get().prefs);
  let timer: number | undefined;
  store.subscribe((s) => {
    const now = JSON.stringify(s.prefs);
    if (now === last) return;
    last = now;
    clearTimeout(timer);
    timer = window.setTimeout(() => void savePrefs(s.prefs), 300);
  });
}

function setStatus(text: string, isError = false): void {
  els.status.textContent = text;
  els.status.classList.toggle('is-error', isError);
}

function showEmpty(message?: string): void {
  els.empty.hidden = false;
  els.root.classList.add('is-empty');
  els.grant.hidden = true;
  els.emptyTitle.textContent = 'Open a PDF';
  els.emptyBody.textContent =
    'Drop a file anywhere on this page, or choose one from your computer.';
  const note = els.empty.querySelector('[data-note]') as HTMLElement;
  note.textContent = message ?? '';
  note.hidden = !message;
  setStatus(message ? 'Could not open file' : 'No file loaded', Boolean(message));
}

/**
 * Read the `file=` parameter.
 *
 * Two producers write it and they encode differently: the service worker
 * percent-encodes, while declarativeNetRequest's regexSubstitution splices the
 * matched URL in raw. URLSearchParams would mangle the raw form (a literal `+`
 * in a path becomes a space), so sniff which one we got.
 */
function readSourceParam(): string | null {
  const m = /(?:^\?|&)file=(.*)$/.exec(location.search);
  if (!m?.[1]) return null;
  const value = m[1];
  return /^(https?|file)%3A/i.test(value) ? decodeURIComponent(value) : value;
}

function filenameFromUrl(url: string): string {
  try {
    // Resolve against the current page so relative sources work too.
    const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || '');
    return name && /\.pdf$/i.test(name) ? name : 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

/**
 * Dev-only test hook. `__DEV__` is an esbuild define, so this whole block is
 * dead code eliminated from production builds — verify with:
 *   npm run build && grep -c __paDev dist/viewer/main.js   # → 0
 */
if (__DEV__) {
  (window as unknown as Record<string, unknown>).__paDev = {
    store,
    renderer,
    reviewToast,
    maybePromptForReview,
    /** IndexedDB handoff, for exercising the local-file path without a worker. */
    handoff: { take: takeHandoff, put: (r: never) => import('@/core/handoff').then((m) => m.putHandoff(r)) },
    /** Concatenated text layer of a page — proves text is real, not raster. */
    pageText: (i: number) => renderer.getPageText(i),
    /** Export and hand back base64, for byte-level inspection in tests. */
    async exportBase64(): Promise<string> {
      const { exportPdf } = await loadExporter();
      const bytes = await exportPdf({
        originalBytes: renderer.getOriginalBytes(),
        annotations: store.get().annotations,
        viewports: renderer.pageViews.map((p) => p.baseViewport),
      });
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    },
    /** Export, then reopen the result — proves annotations are truly burned in. */
    async exportAndReload(): Promise<number> {
      const { exportPdf } = await loadExporter();
      const bytes = await exportPdf({
        originalBytes: renderer.getOriginalBytes(),
        annotations: store.get().annotations,
        viewports: renderer.pageViews.map((p) => p.baseViewport),
      });
      const copy = bytes.slice(0);
      store.set({ annotations: [], selectedId: null, editingId: null });
      await openBytes(copy.buffer as ArrayBuffer);
      return bytes.byteLength;
    },
  };
}

void main();
