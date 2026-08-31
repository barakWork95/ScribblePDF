/**
 * Signature capture: draw once, reuse forever.
 *
 * The drawn stroke is smoothed with quadratic midpoints (raw polylines from
 * pointer events look visibly jagged), rendered at 2x for crispness, then
 * trimmed to its ink bounding box before it is stored. Trimming matters —
 * an untrimmed canvas would place a mostly-empty box on the page and make
 * sizing feel wrong.
 */
import type { SavedSignature } from '@/core/types';
import { addSignature, deleteSignature, loadSignatures } from '@/core/storage';
import { ICONS } from './icons';

const CANVAS_W = 620;
const CANVAS_H = 220;
const SUPERSAMPLE = 2;

export interface SignaturePick {
  dataUrl: string;
  /** width / height of the trimmed PNG. */
  aspect: number;
}

export class SignatureModal {
  readonly el: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private library!: HTMLDivElement;
  private useBtn!: HTMLButtonElement;
  private strokes: Array<Array<{ x: number; y: number }>> = [];
  private current: Array<{ x: number; y: number }> | null = null;
  private color = '#111827';
  private onPick: (p: SignaturePick) => void = () => {};

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'pa-modal';
    this.el.hidden = true;
    this.build();
  }

  private build(): void {
    this.el.innerHTML = `
      <div class="pa-modal__backdrop" data-close></div>
      <div class="pa-modal__panel" role="dialog" aria-modal="true" aria-label="Create a signature">
        <header class="pa-modal__head">
          <h2>Signature</h2>
          <button type="button" class="pa-btn" data-close aria-label="Close">${ICONS.close}</button>
        </header>
        <div class="pa-modal__body">
          <canvas class="pa-sigcanvas" width="${CANVAS_W * SUPERSAMPLE}" height="${CANVAS_H * SUPERSAMPLE}"></canvas>
          <p class="pa-hint">Draw your signature above. It is stored only on this device.</p>
          <div class="pa-modal__controls">
            <div class="pa-swatches" data-ink>
              ${['#111827', '#1d4ed8', '#b91c1c']
                .map(
                  (c) =>
                    `<button type="button" class="pa-swatch" style="--swatch:${c}" data-ink-color="${c}" aria-label="Ink ${c}"></button>`,
                )
                .join('')}
            </div>
            <span class="pa-spacer"></span>
            <button type="button" class="pa-btn pa-btn--text" data-clear>Clear</button>
            <button type="button" class="pa-btn pa-btn--primary" data-use>Save &amp; use</button>
          </div>
          <div class="pa-library">
            <h3>Saved signatures</h3>
            <div class="pa-library__grid" data-library></div>
          </div>
        </div>
      </div>`;

    this.canvas = this.el.querySelector('.pa-sigcanvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.library = this.el.querySelector('[data-library]')!;
    this.useBtn = this.el.querySelector('[data-use]')!;

    this.el.querySelectorAll('[data-close]').forEach((n) =>
      n.addEventListener('click', () => this.close()),
    );
    this.el.querySelector('[data-clear]')!.addEventListener('click', () => this.clear());
    this.useBtn.addEventListener('click', () => void this.saveAndUse());
    this.el.querySelectorAll('[data-ink-color]').forEach((n) =>
      n.addEventListener('click', () => {
        this.color = (n as HTMLElement).dataset.inkColor!;
        this.el.querySelectorAll('[data-ink-color]').forEach((b) => b.classList.remove('is-active'));
        n.classList.add('is-active');
        this.redraw();
      }),
    );
    this.el.querySelector('[data-ink-color]')!.classList.add('is-active');

    this.bindDrawing();
    this.setUseEnabled(false);
  }

  private bindDrawing(): void {
    const pos = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * this.canvas.width,
        y: ((e.clientY - r.top) / r.height) * this.canvas.height,
      };
    };

    this.canvas.addEventListener('pointerdown', (e) => {
      // Capture keeps the stroke alive if the pointer leaves the canvas.
      // Throws InvalidPointerId for pointers the browser isn't tracking.
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* non-fatal: drawing still works, it just won't track outside */
      }
      this.current = [pos(e)];
      this.strokes.push(this.current);
      this.setUseEnabled(true);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.current) return;
      // Coalesced events give us every sample the digitiser produced, which is
      // what makes a fast stroke look smooth instead of polygonal. The list can
      // legitimately come back empty (synthetic events, some input paths), and
      // dropping the sample would lose the stroke entirely — fall back to the
      // event itself.
      const coalesced = e.getCoalescedEvents?.() ?? [];
      for (const ev of coalesced.length > 0 ? coalesced : [e]) this.current.push(pos(ev));
      this.redraw();
    });
    const end = () => {
      this.current = null;
      this.redraw();
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', end);
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 3 * SUPERSAMPLE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of this.strokes) {
      if (stroke.length < 2) {
        const p = stroke[0];
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(stroke[0]!.x, stroke[0]!.y);
      // Quadratic through segment midpoints — cheap Catmull-Rom-ish smoothing.
      for (let i = 1; i < stroke.length - 1; i++) {
        const a = stroke[i]!;
        const b = stroke[i + 1]!;
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      const last = stroke[stroke.length - 1]!;
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
  }

  private clear(): void {
    this.strokes = [];
    this.current = null;
    this.redraw();
    this.setUseEnabled(false);
  }

  private setUseEnabled(on: boolean): void {
    this.useBtn.disabled = !on;
  }

  /** Crop transparent margins so the stored PNG is exactly the ink. */
  private trim(): { dataUrl: string; aspect: number } | null {
    const { width, height } = this.canvas;
    const data = this.ctx.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3]! > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;

    const pad = 4 * SUPERSAMPLE;
    const w = Math.min(width, maxX - minX + 1 + pad * 2);
    const h = Math.min(height, maxY - minY + 1 + pad * 2);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d')!.drawImage(
      this.canvas,
      Math.max(0, minX - pad),
      Math.max(0, minY - pad),
      w,
      h,
      0,
      0,
      w,
      h,
    );
    return { dataUrl: out.toDataURL('image/png'), aspect: w / h };
  }

  private async saveAndUse(): Promise<void> {
    const trimmed = this.trim();
    if (!trimmed) return;
    const sig: SavedSignature = {
      id: `sig_${Date.now().toString(36)}`,
      dataUrl: trimmed.dataUrl,
      pxWidth: Math.round(trimmed.aspect * 100),
      pxHeight: 100,
      createdAt: Date.now(),
    };
    await addSignature(sig);
    await this.refreshLibrary();
    this.onPick(trimmed);
    this.close();
  }

  private async refreshLibrary(): Promise<void> {
    const list = await loadSignatures();
    this.library.replaceChildren();
    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pa-hint';
      empty.textContent = 'Nothing saved yet — draw one above.';
      this.library.append(empty);
      return;
    }
    for (const sig of list) {
      const card = document.createElement('div');
      card.className = 'pa-library__item';
      const img = document.createElement('img');
      img.src = sig.dataUrl;
      img.alt = 'Saved signature';
      card.append(img);
      card.addEventListener('click', () => {
        this.onPick({ dataUrl: sig.dataUrl, aspect: sig.pxWidth / sig.pxHeight });
        this.close();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pa-library__del';
      del.innerHTML = ICONS.trash;
      del.title = 'Delete';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteSignature(sig.id);
        await this.refreshLibrary();
      });
      card.append(del);
      this.library.append(card);
    }
  }

  async open(onPick: (p: SignaturePick) => void): Promise<void> {
    this.onPick = onPick;
    this.el.hidden = false;
    this.clear();
    await this.refreshLibrary();
  }

  close(): void {
    this.el.hidden = true;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }
}
