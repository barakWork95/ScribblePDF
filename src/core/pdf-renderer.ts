/**
 * pdf.js integration: document loading, page shells, lazy canvas rendering.
 *
 * Performance notes:
 *  - Page shells are laid out immediately at the correct aspect ratio so the
 *    scroll height is right on frame 1; canvases fill in lazily.
 *  - An IntersectionObserver renders only pages near the viewport (±1 screen),
 *    which keeps a 300-page document as cheap as a 3-page one.
 *  - Re-rendering (zoom) cancels the in-flight RenderTask first; pdf.js throws
 *    if you render two tasks into the same canvas.
 *  - Canvas backing stores are scaled by devicePixelRatio, capped, so text is
 *    crisp on Retina without allocating 100 MB of pixels at 400% zoom.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { Viewport } from './geometry';
import { assetUrl } from './platform';

/** Guards against absurd canvas allocations at high zoom on HiDPI screens. */
const MAX_CANVAS_SCALE = 3;

export interface PageView {
  index: number;
  /** Positioned wrapper; the annotation layer is its only other child. */
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  layer: HTMLDivElement;
  /** Scale-1 viewport with /Rotate applied — the export reference frame. */
  baseViewport: Viewport;
  /** CSS pixel size at the current zoom. */
  cssWidth: number;
  cssHeight: number;
}

export class PdfRenderer {
  private doc: PDFDocumentProxy | null = null;
  private pages: PageView[] = [];
  private tasks = new Map<number, RenderTask>();
  /** Pages whose canvas currently holds a finished raster at `this.zoom`. */
  private rendered = new Set<number>();
  /** Pages with a render in flight — dedupes overlapping observer callbacks. */
  private inFlight = new Set<number>();
  private observer: IntersectionObserver | null = null;
  private zoom = 1;

  /**
   * The pristine bytes, kept aside for pdf-lib at export time.
   *
   * pdf.js *detaches* the ArrayBuffer it is handed, so the exporter can never
   * reuse the caller's buffer. We copy once, up front, and treat it as
   * immutable for the life of the document.
   */
  private originalBytes: Uint8Array = new Uint8Array(0);

  get pageCount(): number {
    return this.doc?.numPages ?? 0;
  }

  get pageViews(): readonly PageView[] {
    return this.pages;
  }

  getOriginalBytes(): Uint8Array {
    return this.originalBytes;
  }

  async load(bytes: ArrayBuffer): Promise<void> {
    // Set lazily rather than at module scope: the host installs its platform
    // after importing core, so a top-level assetUrl() would run too early.
    pdfjsLib.GlobalWorkerOptions.workerSrc = assetUrl('vendor/pdf.worker.mjs');
    // Opening a second document in the same tab must release the first, or its
    // worker and page caches leak for the lifetime of the tab.
    await this.destroy();
    this.originalBytes = new Uint8Array(bytes.slice(0));
    const task = pdfjsLib.getDocument({
      // Hand pdf.js its own copy; it will detach whatever it receives.
      data: new Uint8Array(bytes.slice(0)),
      cMapUrl: assetUrl('vendor/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: assetUrl('vendor/standard_fonts/'),
      // Local-first: never let pdf.js reach out for anything.
      isEvalSupported: false,
disableAutoFetch: false,
    });
    this.doc = await task.promise;
  }

  /** Build page shells into `container` and start lazy rendering. */
  async layout(container: HTMLElement, zoom: number): Promise<void> {
    if (!this.doc) throw new Error('layout() before load()');
    this.zoom = zoom;
    await this.cancelAll();
    this.teardownObserver();
    container.replaceChildren();
    this.pages = [];
    this.rendered.clear();

    for (let i = 0; i < this.doc.numPages; i++) {
      const page = await this.doc.getPage(i + 1);
      const base = page.getViewport({ scale: 1 }) as unknown as Viewport;

      const el = document.createElement('div');
      el.className = 'pa-page';
      el.dataset.page = String(i);

      const canvas = document.createElement('canvas');
      canvas.className = 'pa-canvas';

      const layer = document.createElement('div');
      layer.className = 'pa-layer';
      layer.dataset.page = String(i);

      el.append(canvas, layer);
      container.append(el);

      const view: PageView = {
        index: i,
        el,
        canvas,
        layer,
        baseViewport: base,
        cssWidth: base.width * zoom,
        cssHeight: base.height * zoom,
      };
      this.applySize(view);
      this.pages.push(view);
      page.cleanup();
    }

    this.setupObserver(container);
  }

  private applySize(view: PageView): void {
    view.cssWidth = view.baseViewport.width * this.zoom;
    view.cssHeight = view.baseViewport.height * this.zoom;
    view.el.style.width = `${view.cssWidth}px`;
    view.el.style.height = `${view.cssHeight}px`;
  }

  /** Render pages within one viewport-height of the scroll position. */
  private setupObserver(container: HTMLElement): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const idx = Number((e.target as HTMLElement).dataset.page);
          void this.renderPage(idx);
        }
      },
      { root: container.parentElement, rootMargin: '100% 0px' },
    );
    for (const p of this.pages) this.observer.observe(p.el);
  }

  private teardownObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /**
   * Cancel a page's in-flight render and *wait for it to actually stop*.
   *
   * RenderTask.cancel() only requests cancellation; the task promise settles
   * later. Starting a second render on the same canvas before that happens
   * makes pdf.js reject with "Cannot use the same canvas during multiple
   * render() operations" — or, worse, hang both promises forever. Awaiting the
   * rejection here is what makes rapid zooming safe.
   */
  private async cancelTask(index: number): Promise<void> {
    const task = this.tasks.get(index);
    if (!task) return;
    task.cancel();
    try {
      await task.promise;
    } catch {
      /* RenderingCancelledException is the expected outcome */
    }
    this.tasks.delete(index);
  }

  private async cancelAll(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((i) => this.cancelTask(i)));
    this.tasks.clear();
    this.inFlight.clear();
  }

  async renderPage(index: number): Promise<void> {
    const view = this.pages[index];
    if (!this.doc || !view) return;
    if (this.rendered.has(index) || this.inFlight.has(index)) return;

    const doc = this.doc;
    this.inFlight.add(index);
    try {
      await this.cancelTask(index);
      // The document may have been swapped out while we waited.
      if (this.doc !== doc || this.pages[index] !== view) return;

      const page: PDFPageProxy = await doc.getPage(index + 1);
      if (this.doc !== doc || this.pages[index] !== view) return;

      const dpr = Math.min(
        window.devicePixelRatio || 1,
        MAX_CANVAS_SCALE / Math.max(this.zoom, 1),
      );
      const viewport = page.getViewport({ scale: this.zoom * dpr });
      const ctx = view.canvas.getContext('2d', { alpha: false });
      if (!ctx) return;

      // Assigning width/height also clears the canvas, which pdf.js requires
      // before reusing it for a new raster.
      view.canvas.width = Math.floor(viewport.width);
      view.canvas.height = Math.floor(viewport.height);
      view.canvas.style.width = `${view.cssWidth}px`;
      view.canvas.style.height = `${view.cssHeight}px`;

      const task = page.render({ canvasContext: ctx, viewport });
      this.tasks.set(index, task);
      try {
        await task.promise;
        this.rendered.add(index);
        view.el.classList.add('is-rendered');
      } catch (err) {
        // A cancel during zoom is expected; anything else is worth surfacing.
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
          console.error(`[scribblepdf] page ${index + 1} failed to render`, err);
        }
      } finally {
        this.tasks.delete(index);
      }
    } finally {
      this.inFlight.delete(index);
    }
  }

  /** Resize every shell, then re-rasterize whatever is currently on screen. */
  async setZoom(zoom: number): Promise<void> {
    this.zoom = zoom;
    // Everything on screen is now the wrong resolution; stop it before the
    // canvases are resized out from under the in-flight tasks.
    const wasRendered = new Set([...this.rendered, ...this.inFlight]);
    await this.cancelAll();
    this.rendered.clear();
    for (const view of this.pages) this.applySize(view);
    await Promise.all([...wasRendered].map((i) => this.renderPage(i)));
  }

  getZoom(): number {
    return this.zoom;
  }

  /** Zoom that fits the widest page into `availableWidth` CSS px. */
  fitWidthZoom(availableWidth: number): number {
    const widest = Math.max(...this.pages.map((p) => p.baseViewport.width), 1);
    return Math.max(0.25, Math.min(4, availableWidth / widest));
  }

  /**
   * Extract a page's text layer. Used by the test suite to prove exported text
   * is real, selectable text rather than a raster; also the hook a future
   * find-in-document feature would build on.
   */
  async getPageText(index: number): Promise<string> {
    if (!this.doc) return '';
    const page = await this.doc.getPage(index + 1);
    const content = await page.getTextContent();
    return content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join('');
  }

  async destroy(): Promise<void> {
    this.teardownObserver();
    await this.cancelAll();
    this.rendered.clear();
    const doc = this.doc;
    this.doc = null;
    await doc?.destroy();
  }
}
