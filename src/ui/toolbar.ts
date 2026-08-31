/**
 * The floating toolbar.
 *
 * Layout follows the design reference: the primary tools are a segmented strip
 * of tiles, each a bold glyph over a label, divided by hairlines inside a
 * single frame. Secondary controls (select, history, zoom, open) and the
 * contextual style controls live on a second, quieter row.
 *
 * Plain DOM driven by store subscriptions — no virtual DOM. Only attributes
 * that actually change are touched on each state push, so a 60fps drag never
 * causes layout thrash in the toolbar.
 */
import type { Store, State } from '@/core/store';
import type { FontFamilyId, Preferences, ToolId } from '@/core/types';
import { ICONS, TILE_ICONS } from './icons';

export interface ToolbarHandlers {
  onExport: () => void;
  onSignature: () => void;
  onOpenFile: () => void;
  onZoom: (delta: number) => void;
}

/** The four tiles from the design reference. Select lives on the utility row. */
const TOOLS: Array<{ id: ToolId; icon: keyof typeof TILE_ICONS; label: string; key: string }> = [
  { id: 'text', icon: 'text', label: 'Text', key: 'T' },
  { id: 'check', icon: 'check', label: 'Check', key: 'C' },
  { id: 'cross', icon: 'cross', label: 'Cross', key: 'X' },
  { id: 'signature', icon: 'signature', label: 'Signature', key: 'S' },
];

const SWATCHES = ['#1f2937', '#1d4ed8', '#dc2626', '#059669', '#d97706'];

const FONTS: Array<{ id: FontFamilyId; label: string }> = [
  { id: 'helvetica', label: 'Helvetica' },
  { id: 'times', label: 'Times' },
  { id: 'courier', label: 'Courier' },
];

/** Reference page height, in points, for showing sizes as familiar numbers. */
const SIZE_REFERENCE_PT = 792;

export class Toolbar {
  readonly el: HTMLDivElement;

  private toolTiles = new Map<ToolId, HTMLButtonElement>();
  private selectBtn!: HTMLButtonElement;
  private exportTile!: HTMLButtonElement;
  private utilityRow!: HTMLDivElement;
  private styleGroup!: HTMLDivElement;
  private swatchButtons = new Map<string, HTMLButtonElement>();
  private fontSelect!: HTMLSelectElement;
  private sizeInput!: HTMLInputElement;
  private boldBtn!: HTMLButtonElement;
  private italicBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;

  constructor(
    private store: Store,
    private handlers: ToolbarHandlers,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'pa-toolbar';
    this.el.setAttribute('role', 'toolbar');
    this.el.setAttribute('aria-label', 'PDF annotation tools');
    this.build();
    this.makeDraggable();
    this.store.subscribe((s) => this.sync(s));
  }

  // ------------------------------------------------------------------ build

  private build(): void {
    this.el.append(this.buildTileRow(), this.buildUtilityRow());
  }

  private buildTileRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'pa-toolbar__tiles';

    const grip = document.createElement('div');
    grip.className = 'pa-grip';
    grip.innerHTML = ICONS.grip;
    grip.title = 'Drag to move';
    row.append(grip);

    const strip = document.createElement('div');
    strip.className = 'pa-strip';
    for (const tool of TOOLS) {
      const tile = this.makeTile(tool.icon, tool.label, `${tool.label} (${tool.key})`);
      tile.addEventListener('click', () => this.pickTool(tool.id));
      this.toolTiles.set(tool.id, tile);
      strip.append(tile);
    }
    row.append(strip);

    const exportStrip = document.createElement('div');
    exportStrip.className = 'pa-strip pa-strip--action';
    this.exportTile = this.makeTile('download', 'Download', 'Export the annotated PDF (⌘S)');
    this.exportTile.classList.add('pa-tile--action');
    this.exportTile.addEventListener('click', () => this.handlers.onExport());
    exportStrip.append(this.exportTile);
    row.append(exportStrip);

    return row;
  }

  private makeTile(
    icon: keyof typeof TILE_ICONS,
    label: string,
    title: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pa-tile';
    button.title = title;
    button.setAttribute('aria-label', title);

    const glyph = document.createElement('span');
    glyph.className = 'pa-tile__glyph';
    glyph.innerHTML = TILE_ICONS[icon];

    const caption = document.createElement('span');
    caption.className = 'pa-tile__label';
    caption.textContent = label;

    button.append(glyph, caption);
    return button;
  }

  private buildUtilityRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'pa-toolbar__utility';
    this.utilityRow = row;

    this.selectBtn = this.iconButton('cursor', 'Select (V)');
    this.selectBtn.addEventListener('click', () =>
      this.store.set({ tool: 'select', editingId: null }),
    );

    this.undoBtn = this.iconButton('undo', 'Undo (⌘Z)');
    this.undoBtn.addEventListener('click', () => this.store.undo());
    this.redoBtn = this.iconButton('redo', 'Redo (⇧⌘Z)');
    this.redoBtn.addEventListener('click', () => this.store.redo());

    const zoomOut = this.iconButton('zoomOut', 'Zoom out');
    zoomOut.addEventListener('click', () => this.handlers.onZoom(-0.15));
    const zoomIn = this.iconButton('zoomIn', 'Zoom in');
    zoomIn.addEventListener('click', () => this.handlers.onZoom(0.15));

    const open = this.iconButton('folder', 'Open another PDF');
    open.addEventListener('click', () => this.handlers.onOpenFile());

    row.append(
      this.selectBtn,
      this.divider(),
      this.undoBtn,
      this.redoBtn,
      this.divider(),
      zoomOut,
      zoomIn,
      open,
    );

    this.styleGroup = document.createElement('div');
    this.styleGroup.className = 'pa-style';
    this.buildStyleControls();
    row.append(this.styleGroup);

    return row;
  }

  private buildStyleControls(): void {
    const colors = document.createElement('div');
    colors.className = 'pa-swatches';
    for (const hex of SWATCHES) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'pa-swatch';
      swatch.style.setProperty('--swatch', hex);
      swatch.title = hex;
      swatch.setAttribute('aria-label', `Colour ${hex}`);
      swatch.addEventListener('click', () => this.patchPrefs({ color: hex }));
      this.swatchButtons.set(hex, swatch);
      colors.append(swatch);
    }

    this.fontSelect = document.createElement('select');
    this.fontSelect.className = 'pa-select';
    this.fontSelect.title = 'Font';
    for (const font of FONTS) {
      const option = document.createElement('option');
      option.value = font.id;
      option.textContent = font.label;
      this.fontSelect.append(option);
    }
    this.fontSelect.addEventListener('change', () =>
      this.patchPrefs({ fontFamily: this.fontSelect.value as FontFamilyId }),
    );

    this.boldBtn = this.textButton('B', 'Bold');
    this.boldBtn.style.fontWeight = '700';
    this.boldBtn.addEventListener('click', () =>
      this.patchPrefs({ bold: !this.store.get().prefs.bold }),
    );

    this.italicBtn = this.textButton('I', 'Italic');
    this.italicBtn.style.fontStyle = 'italic';
    this.italicBtn.addEventListener('click', () =>
      this.patchPrefs({ italic: !this.store.get().prefs.italic }),
    );

    // Size is stored as a fraction of page height; the slider shows the
    // equivalent point size on a Letter page so the number means something.
    this.sizeInput = document.createElement('input');
    this.sizeInput.type = 'range';
    this.sizeInput.className = 'pa-range';
    this.sizeInput.min = '8';
    this.sizeInput.max = '48';
    this.sizeInput.step = '1';
    this.sizeInput.title = 'Size';
    this.sizeInput.addEventListener('input', () => this.onSizeInput());

    const remove = this.iconButton('trash', 'Delete selected (⌫)');
    remove.addEventListener('click', () => {
      const id = this.store.get().selectedId;
      if (id) this.store.remove(id);
    });

    this.styleGroup.append(
      this.divider(),
      colors,
      this.fontSelect,
      this.boldBtn,
      this.italicBtn,
      this.sizeInput,
      remove,
    );
  }

  // ---------------------------------------------------------------- actions

  private onSizeInput(): void {
    const fraction = Number(this.sizeInput.value) / SIZE_REFERENCE_PT;
    const { tool, selectedId } = this.store.get();
    const selected = this.store.byId(selectedId);
    if (selected && selected.kind !== 'signature') {
      this.store.update(selected.id, { size: fraction });
    }
    if (tool === 'text' || selected?.kind === 'text') this.patchPrefs({ textSize: fraction });
    else this.patchPrefs({ markSize: fraction });
  }

  private patchPrefs(patch: Partial<Preferences>): void {
    this.store.set({ prefs: { ...this.store.get().prefs, ...patch } });

    // Style changes apply live to the current selection, which is what users
    // expect from a floating toolbar sitting over a selected object.
    const selected = this.store.byId(this.store.get().selectedId);
    if (!selected) return;
    if (patch.color) this.store.update(selected.id, { color: patch.color });
    if (selected.kind === 'text') {
      const textPatch: Record<string, unknown> = {};
      if (patch.fontFamily) textPatch.fontFamily = patch.fontFamily;
      if (patch.bold !== undefined) textPatch.bold = patch.bold;
      if (patch.italic !== undefined) textPatch.italic = patch.italic;
      if (Object.keys(textPatch).length) this.store.update(selected.id, textPatch as never);
    }
  }

  /** Tiles are toggles: clicking the active tool returns to Select. */
  private pickTool(id: ToolId): void {
    const next = this.store.get().tool === id ? 'select' : id;
    this.store.set({ tool: next, selectedId: null, editingId: null });
    if (next === 'signature') this.handlers.onSignature();
  }

  // ------------------------------------------------------------------- sync

  private sync(s: State): void {
    for (const [id, tile] of this.toolTiles) {
      const active = s.tool === id;
      tile.classList.toggle('is-active', active);
      tile.setAttribute('aria-pressed', String(active));
    }
    this.selectBtn.classList.toggle('is-active', s.tool === 'select');

    for (const [hex, swatch] of this.swatchButtons) {
      swatch.classList.toggle('is-active', s.prefs.color === hex);
    }

    const selected = this.store.byId(s.selectedId);
    const textish = s.tool === 'text' || selected?.kind === 'text';

    this.styleGroup.classList.toggle('is-hidden', s.tool === 'select' && !selected);
    this.fontSelect.classList.toggle('is-hidden', !textish);
    this.boldBtn.classList.toggle('is-hidden', !textish);
    this.italicBtn.classList.toggle('is-hidden', !textish);
    this.sizeInput.classList.toggle('is-hidden', selected?.kind === 'signature');

    this.fontSelect.value = selected?.kind === 'text' ? selected.fontFamily : s.prefs.fontFamily;
    this.boldBtn.classList.toggle(
      'is-active',
      selected?.kind === 'text' ? selected.bold : s.prefs.bold,
    );
    this.italicBtn.classList.toggle(
      'is-active',
      selected?.kind === 'text' ? selected.italic : s.prefs.italic,
    );

    const size =
      selected && selected.kind !== 'signature'
        ? selected.size
        : textish
          ? s.prefs.textSize
          : s.prefs.markSize;
    if (document.activeElement !== this.sizeInput) {
      this.sizeInput.value = String(Math.round(size * SIZE_REFERENCE_PT));
    }

    this.undoBtn.disabled = !this.store.canUndo;
    this.redoBtn.disabled = !this.store.canRedo;
    this.exportTile.classList.toggle('is-dirty', s.dirty);
  }

  setExporting(busy: boolean): void {
    this.exportTile.disabled = busy;
    this.exportTile.classList.toggle('is-busy', busy);
    const label = this.exportTile.querySelector('.pa-tile__label');
    if (label) label.textContent = busy ? 'Working…' : 'Download';
  }

  // ---------------------------------------------------------------- helpers

  private iconButton(icon: keyof typeof ICONS, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pa-btn';
    button.innerHTML = ICONS[icon];
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
  }

  private textButton(text: string, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pa-btn pa-btn--text';
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
  }

  private divider(): HTMLSpanElement {
    const divider = document.createElement('span');
    divider.className = 'pa-divider';
    return divider;
  }

  /**
   * Drag by the grip. The toolbar is fixed-positioned and only `left`/`top`
   * change, so dragging never reflows the document underneath.
   */
  private makeDraggable(): void {
    const grip = this.el.querySelector('.pa-grip') as HTMLElement;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    const onMove = (e: PointerEvent): void => {
      const x = originX + (e.clientX - startX);
      const y = originY + (e.clientY - startY);
      const rect = this.el.getBoundingClientRect();
      this.el.style.left = `${Math.min(Math.max(8, x), window.innerWidth - rect.width - 8)}px`;
      this.el.style.top = `${Math.min(Math.max(8, y), window.innerHeight - rect.height - 8)}px`;
      this.el.style.bottom = 'auto';
      this.el.style.transform = 'none';
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.el.classList.remove('is-dragging');
    };

    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = this.el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      originX = rect.left;
      originY = rect.top;
      this.el.classList.add('is-dragging');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
}
