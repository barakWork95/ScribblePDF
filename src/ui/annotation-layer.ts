/**
 * The interactive overlay that sits on top of every rendered page.
 *
 * Responsibilities: place new annotations, render existing ones as DOM nodes,
 * and handle select / drag / resize / in-place text editing.
 *
 * Rendering is diffed by annotation id rather than rebuilt, for two reasons:
 * a full rebuild at 60fps during a drag is wasteful, and — more importantly —
 * replacing a contenteditable node while the user is typing destroys the caret.
 */
import type { Store } from '@/core/store';
import type { Annotation, SignatureAnnotation, TextAnnotation } from '@/core/types';
import type { PageView } from '@/core/pdf-renderer';
import { GLYPHS, clamp } from '@/core/geometry';
import { LINE_HEIGHT, cssFamily } from '@/core/text-style';
import { uid } from '@/core/store';

/** Minimum on-screen size for a signature, in CSS px, while resizing. */
const MIN_SIG_PX = 24;

export class AnnotationLayer {
  private nodes = new Map<string, HTMLElement>();
  private pages: readonly PageView[] = [];

  constructor(private store: Store) {
    this.store.subscribe(() => this.render());
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  attach(pages: readonly PageView[]): void {
    this.pages = pages;
    this.nodes.clear();
    for (const p of pages) {
      p.layer.addEventListener('pointerdown', (e) => this.onLayerPointerDown(e, p));
    }
    this.render();
  }

  /** Re-position everything after a zoom change (sizes are zoom-dependent). */
  reflow(): void {
    this.render(true);
  }

  // ---------------------------------------------------------------- placement

  private onLayerPointerDown(e: PointerEvent, page: PageView): void {
    // Only react to clicks on bare page area, not on an existing annotation.
    if (e.target !== page.layer) return;
    const s = this.store.get();

    if (s.tool === 'select') {
      this.store.set({ selectedId: null, editingId: null });
      return;
    }

    // Suppress the default focus shift: without this, mousedown moves focus to
    // the layer *after* we focus a freshly created text box, and the user's
    // first keystrokes go nowhere.
    e.preventDefault();

    const rect = page.layer.getBoundingClientRect();
    const nx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const ny = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    this.place(s.tool, page, nx, ny);
  }

  private place(tool: string, page: PageView, nx: number, ny: number): void {
    const { prefs, pendingSignature } = this.store.get();
    const base = {
      id: uid(),
      page: page.index,
      color: prefs.color,
      createdAt: Date.now(),
    };

    if (tool === 'text') {
      const ann: TextAnnotation = {
        ...base,
        kind: 'text',
        // Click point becomes the text baseline-ish centre, not the corner.
        x: nx,
        y: clamp(ny - prefs.textSize / 2, 0, 1),
        text: '',
        size: prefs.textSize,
        fontFamily: prefs.fontFamily,
        bold: prefs.bold,
        italic: prefs.italic,
      };
      this.store.add(ann);
      this.store.set({ selectedId: ann.id, editingId: ann.id, tool: 'select' });
      queueMicrotask(() => this.focusText(ann.id));
      return;
    }

    if (tool === 'check' || tool === 'cross') {
      const size = prefs.markSize;
      this.store.add({
        ...base,
        kind: tool,
        // Centre the stamp on the cursor — it reads as "stamp here".
        x: clamp(nx - (size * page.cssHeight) / page.cssWidth / 2, 0, 1),
        y: clamp(ny - size / 2, 0, 1),
        size,
        weight: size * 0.16,
      });
      return;
    }

    if (tool === 'signature' && pendingSignature) {
      const heightN = 0.06;
      const widthN =
        (heightN * page.cssHeight * pendingSignature.aspect) / page.cssWidth;
      const ann: SignatureAnnotation = {
        ...base,
        kind: 'signature',
        x: clamp(nx - widthN / 2, 0, 1),
        y: clamp(ny - heightN / 2, 0, 1),
        dataUrl: pendingSignature.dataUrl,
        width: widthN,
        height: heightN,
      };
      this.store.add(ann);
      this.store.set({ selectedId: ann.id, tool: 'select' });
    }
  }

  /** Focus a text box and drop the caret at the end of its content. */
  private focusText(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // ----------------------------------------------------------------- render

  private render(force = false): void {
    const s = this.store.get();
    const seen = new Set<string>();

    for (const ann of s.annotations) {
      const page = this.pages[ann.page];
      if (!page) continue;
      seen.add(ann.id);
      let node = this.nodes.get(ann.id);
      if (!node) {
        node = this.createNode(ann, page);
        this.nodes.set(ann.id, node);
        page.layer.append(node);
      }
      this.updateNode(node, ann, page, s.editingId === ann.id, force);
      node.classList.toggle('is-selected', s.selectedId === ann.id);
    }

    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }

    for (const p of this.pages) {
      p.layer.classList.toggle('is-placing', s.tool !== 'select');
    }
  }

  private createNode(ann: Annotation, page: PageView): HTMLElement {
    const node = document.createElement('div');
    node.className = `pa-ann pa-ann--${ann.kind}`;
    node.dataset.id = ann.id;

    if (ann.kind === 'text') {
      node.contentEditable = 'plaintext-only';
      node.spellcheck = false;
      // Base direction from the first strong character, matching what the
      // exporter's bidi pass does. Without this the browser would use the CSS
      // base direction (LTR) and a Hebrew line would lay out differently on
      // screen than in the exported PDF.
      node.dir = 'auto';
      node.addEventListener('blur', () => {
        const current = this.store.byId(ann.id);
        if (!current || current.kind !== 'text') return;
        const text = node.innerText.replace(/\n$/, '');
        // An empty text box is a mis-click, not an annotation.
        if (text.trim() === '') this.store.remove(ann.id);
        else if (text !== current.text) this.store.update(ann.id, { text });
        if (this.store.get().editingId === ann.id) this.store.set({ editingId: null });
      });
      node.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') node.blur();
      });
      node.addEventListener('dblclick', () => {
        this.store.set({ editingId: ann.id, selectedId: ann.id });
        this.focusText(ann.id);
      });
    }

    if (ann.kind === 'signature') {
      const img = document.createElement('img');
      img.className = 'pa-ann__img';
      img.draggable = false;
      node.append(img);
      node.append(this.resizeHandle(ann.id, page));
    }

    node.addEventListener('pointerdown', (e) => this.onNodePointerDown(e, ann.id, page));
    return node;
  }

  private updateNode(
    node: HTMLElement,
    ann: Annotation,
    page: PageView,
    editing: boolean,
    force: boolean,
  ): void {
    node.style.left = `${ann.x * 100}%`;
    node.style.top = `${ann.y * 100}%`;
    node.style.color = ann.color;

    if (ann.kind === 'text') {
      const px = ann.size * page.cssHeight;
      node.style.fontSize = `${px}px`;
      node.style.lineHeight = String(LINE_HEIGHT);
      node.style.fontFamily = cssFamily(ann.fontFamily);
      node.style.fontWeight = ann.bold ? '700' : '400';
      node.style.fontStyle = ann.italic ? 'italic' : 'normal';
      node.classList.toggle('is-editing', editing);
      // Never rewrite the DOM text while the caret is in it.
      if (!editing && (force || node.innerText.replace(/\n$/, '') !== ann.text)) {
        node.innerText = ann.text;
      }
      return;
    }

    if (ann.kind === 'check' || ann.kind === 'cross') {
      const px = ann.size * page.cssHeight;
      node.style.width = `${px}px`;
      node.style.height = `${px}px`;
      const stroke = (ann.weight / ann.size) * 100;
      // Rebuild the SVG only when geometry actually changed.
      const key = `${ann.kind}:${stroke.toFixed(2)}`;
      if (node.dataset.glyph !== key) {
        node.dataset.glyph = key;
        node.innerHTML = glyphSvg(ann.kind, stroke);
      }
      return;
    }

    if (ann.kind === 'signature') {
      const img = node.querySelector('img');
      if (img && img.getAttribute('src') !== ann.dataUrl) img.src = ann.dataUrl;
      node.style.width = `${ann.width * page.cssWidth}px`;
      node.style.height = `${ann.height * page.cssHeight}px`;
    }
  }

  // ------------------------------------------------------- drag and resize

  private onNodePointerDown(e: PointerEvent, id: string, page: PageView): void {
    if ((e.target as HTMLElement).classList.contains('pa-handle')) return;
    const s = this.store.get();
    if (s.editingId === id) return; // let the caret work
    e.stopPropagation();

    this.store.set({ selectedId: id, tool: 'select' });

    const ann = this.store.byId(id);
    if (!ann) return;
    const rect = page.layer.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = ann.x;
    const originY = ann.y;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      this.store.updateTransient(
        id,
        { x: clamp(originX + dx, 0, 1), y: clamp(originY + dy, 0, 1) },
        !moved,
      );
      moved = true;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // A click that never moved on a text box means "edit me".
      if (!moved && ann.kind === 'text') {
        this.store.set({ editingId: id });
        this.focusText(id);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private resizeHandle(id: string, page: PageView): HTMLElement {
    const h = document.createElement('div');
    h.className = 'pa-handle';
    h.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const ann = this.store.byId(id);
      if (!ann || ann.kind !== 'signature') return;
      const rect = page.layer.getBoundingClientRect();
      const startX = e.clientX;
      const w0 = ann.width;
      const h0 = ann.height;
      const aspectPx = (w0 * page.cssWidth) / (h0 * page.cssHeight);
      let first = true;

      const onMove = (ev: PointerEvent) => {
        const widthPx = Math.max(MIN_SIG_PX, w0 * page.cssWidth + (ev.clientX - startX));
        const width = widthPx / page.cssWidth;
        const height = widthPx / aspectPx / page.cssHeight;
        this.store.updateTransient(
          id,
          { width: clamp(width, 0.01, 1), height: clamp(height, 0.005, 1) },
          first,
        );
        first = false;
        void rect;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    return h;
  }

  // ------------------------------------------------------------- keyboard

  private onKeyDown(e: KeyboardEvent): void {
    const s = this.store.get();
    if (s.editingId) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

    if ((e.key === 'Backspace' || e.key === 'Delete') && s.selectedId) {
      e.preventDefault();
      this.store.remove(s.selectedId);
      return;
    }
    // Arrow-key nudge: 1 unit ≈ 0.1% of the page, 10x with Shift.
    if (s.selectedId && e.key.startsWith('Arrow')) {
      const ann = this.store.byId(s.selectedId);
      if (!ann) return;
      e.preventDefault();
      const step = (e.shiftKey ? 0.01 : 0.001) * (e.altKey ? 5 : 1);
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      this.store.update(ann.id, { x: clamp(ann.x + dx, 0, 1), y: clamp(ann.y + dy, 0, 1) });
    }
  }
}

/**
 * Build the on-screen glyph from the same unit polyline the exporter uses, so
 * the preview cannot drift from the burned-in result.
 */
function glyphSvg(kind: 'check' | 'cross', strokePercent: number): string {
  const paths = GLYPHS[kind]
    .map((stroke) => {
      const d = stroke
        .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${(x * 100).toFixed(2)} ${(y * 100).toFixed(2)}`)
        .join(' ');
      return `<path d="${d}"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="${strokePercent.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
