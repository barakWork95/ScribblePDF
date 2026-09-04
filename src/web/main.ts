/**
 * Web / PWA entry point.
 *
 * Same core and same UI components as the extension; only the host differs.
 * Everything the extension does that has no meaning here — site permissions,
 * returning to an original PDF tab, the store review prompt, the file:// bytes
 * handoff — is simply absent rather than stubbed, because the platform seam
 * (core/platform.ts) keeps those concerns out of core in the first place.
 *
 * PRIVACY: identical to the extension. The document is opened, edited and
 * saved entirely in the tab. There is no upload and no server; once the service
 * worker has cached the shell the app runs fully offline.
 */
import { setPlatform } from '@/core/platform';
import { webPlatform } from '@/platform/web';
import { PdfRenderer } from '@/core/pdf-renderer';
import { Store } from '@/core/store';
import { Toolbar } from '@/ui/toolbar';
import { AnnotationLayer } from '@/ui/annotation-layer';
import { SignatureModal } from '@/ui/signature-modal';
import { loadPrefs, savePrefs } from '@/core/storage';
import { warmUpFontMetrics } from '@/core/text-style';
import { clamp } from '@/core/geometry';

setPlatform(webPlatform);

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

/** Narrower gutter than the extension: screen width is scarce on a phone. */
const PAGE_GUTTER = 24;

/** Below this the layout switches to its touch arrangement. */
const MOBILE_BREAKPOINT = 760;

const els = {
  root: document.getElementById('app') as HTMLDivElement,
  scroll: document.getElementById('scroll') as HTMLDivElement,
  pages: document.getElementById('pages') as HTMLDivElement,
  status: document.getElementById('status') as HTMLSpanElement,
  title: document.getElementById('doc-title') as HTMLSpanElement,
  empty: document.getElementById('empty') as HTMLElement,
  file: document.getElementById('file') as HTMLInputElement,
  close: document.getElementById('close-doc') as HTMLButtonElement,
};

const store = new Store();
const renderer = new PdfRenderer();
const layer = new AnnotationLayer(store);
const signatureModal = new SignatureModal();
let sourceName = 'document.pdf';

const toolbar = new Toolbar(store, {
  onExport: () => void doExport(),
  onSignature: () => void openSignature(),
  onOpenFile: () => els.file.click(),
  onZoom: (delta) => void setZoom(renderer.getZoom() + delta),
});

document.body.append(toolbar.el, signatureModal.el);

// ---------------------------------------------------------------- bootstrap

async function main(): Promise<void> {
  store.set({ prefs: await loadPrefs() });
  persistPrefsOnChange();
  bindFileInputs();
  bindShortcuts();
  bindViewportChanges();
  await warmUpFontMetrics();
  showEmpty();
  void registerServiceWorker();
}

async function openBytes(bytes: ArrayBuffer, name: string): Promise<void> {
  sourceName = name;
  setStatus('Rendering…');
  els.empty.hidden = true;
  els.root.classList.remove('is-empty');
  try {
    await renderer.load(bytes);
  } catch (err) {
    showEmpty(`That file could not be opened as a PDF (${(err as Error).message}).`);
    return;
  }
  await renderer.layout(els.pages, 1);
  await setZoom(fitZoom(), true);
  layer.attach(renderer.pageViews);
  els.title.textContent = name;
  els.close.hidden = false;
  document.title = `${name} — ScribblePDF`;
  setStatus(`${renderer.pageCount} page${renderer.pageCount === 1 ? '' : 's'}`);
}

/** Fit the widest page to the viewport, which is what a phone always wants. */
function fitZoom(): number {
  return clamp(renderer.fitWidthZoom(els.scroll.clientWidth - PAGE_GUTTER), ZOOM_MIN, ZOOM_MAX);
}

// --------------------------------------------------------------------- zoom

let zoomPending: Promise<void> = Promise.resolve();

async function setZoom(next: number, silent = false): Promise<void> {
  const zoom = clamp(Number(next.toFixed(2)), ZOOM_MIN, ZOOM_MAX);
  if (zoom === renderer.getZoom()) return;
  zoomPending = zoomPending.then(async () => {
    await renderer.setZoom(zoom);
    layer.reflow();
    if (!silent) setStatus(`${Math.round(zoom * 100)}%`);
  });
  await zoomPending;
}

/**
 * Two-finger pinch to zoom the document.
 *
 * The page itself must not zoom — that would scale the toolbar too — so the
 * viewport is locked and this drives the renderer instead, which re-rasterises
 * at the new scale and keeps text crisp rather than blowing up pixels.
 */
function bindPinchZoom(): void {
  const points = new Map<number, { x: number; y: number }>();
  let startSpread = 0;
  let startZoom = 1;

  const spread = (): number => {
    const [a, b] = [...points.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  els.scroll.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 2) {
      startSpread = spread();
      startZoom = renderer.getZoom();
    }
  });

  els.scroll.addEventListener(
    'pointermove',
    (e) => {
      if (!points.has(e.pointerId)) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size !== 2 || startSpread === 0) return;
      e.preventDefault(); // stop the scroll container panning mid-pinch
      void setZoom(startZoom * (spread() / startSpread));
    },
    { passive: false },
  );

  const release = (e: PointerEvent): void => {
    points.delete(e.pointerId);
    if (points.size < 2) startSpread = 0;
  };
  els.scroll.addEventListener('pointerup', release);
  els.scroll.addEventListener('pointercancel', release);
}

/** Refit on rotation and on resize; a phone changes width constantly. */
function bindViewportChanges(): void {
  let timer: number | undefined;
  const refit = (): void => {
    if (renderer.pageCount === 0) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => void setZoom(fitZoom(), true), 150);
  };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  bindPinchZoom();
}

// ------------------------------------------------------------------- export

async function doExport(): Promise<void> {
  const { annotations } = store.get();
  toolbar.setExporting(true);
  setStatus('Writing PDF…');
  try {
    const { exportPdf, downloadBytes } = await import('@/core/exporter');
    const bytes = await exportPdf({
      originalBytes: renderer.getOriginalBytes(),
      annotations,
      viewports: renderer.pageViews.map((p) => p.baseViewport),
    });
    downloadBytes(bytes, sourceName.replace(/\.pdf$/i, '') + ' (annotated).pdf');
    store.markClean();
    setStatus(`Exported ${annotations.length} annotation${annotations.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('[scribblepdf] export failed', err);
    setStatus(`Export failed: ${(err as Error).message}`, true);
  } finally {
    toolbar.setExporting(false);
  }
}

async function openSignature(): Promise<void> {
  await signatureModal.open((pick) => {
    store.set({ pendingSignature: pick, tool: 'signature' });
    setStatus('Tap the page to place your signature');
  });
}

// --------------------------------------------------------------- file input

function bindFileInputs(): void {
  els.file.addEventListener('change', async () => {
    const file = els.file.files?.[0];
    if (!file) return;
    await openBytes(await file.arrayBuffer(), file.name);
    els.file.value = '';
  });

  els.close.addEventListener('click', () => {
    if (store.get().dirty && !confirm('Close this document? Your annotations will be discarded.')) {
      return;
    }
    void closeDocument();
  });

  const stop = (e: DragEvent): void => {
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
    const file = e.dataTransfer?.files?.[0];
    if (!file || !/\.pdf$/i.test(file.name)) return;
    await openBytes(await file.arrayBuffer(), file.name);
  });
}

async function closeDocument(): Promise<void> {
  await renderer.destroy();
  els.pages.replaceChildren();
  store.set({ annotations: [], selectedId: null, editingId: null, tool: 'select' });
  store.markClean();
  els.title.textContent = '';
  els.close.hidden = true;
  document.title = 'ScribblePDF';
  showEmpty();
}

function bindShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void doExport();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (!store.get().dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// -------------------------------------------------------------------- misc

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
  const note = els.empty.querySelector('[data-note]') as HTMLElement;
  note.textContent = message ?? '';
  note.hidden = !message;
  setStatus(message ? 'Could not open file' : '', Boolean(message));
}

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, {
      scope: './',
    });
  } catch (err) {
    // Offline support is a bonus; the app works fine without it.
    console.warn('[scribblepdf] service worker registration failed', err);
  }
}

export const isMobileLayout = (): boolean => window.innerWidth < MOBILE_BREAKPOINT;

void main();
