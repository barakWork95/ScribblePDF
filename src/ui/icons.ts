/**
 * Inline SVG icons. Inlined rather than sprited or fetched so the toolbar
 * paints in the first frame with no extra round trip and no CSP exceptions.
 * All are 24x24, stroke-based, and inherit `currentColor`.
 */
const svg = (body: string, fill = false): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  cursor: svg('<path d="M5 3l6.5 16 2.2-6.8L20.5 10z"/>'),
  text: svg('<path d="M5.5 19 12 5l6.5 14"/><path d="M8 14.5h8"/>'),
  check: svg('<path d="M4.5 12.6 9.3 17.5 19.5 6.8"/>'),
  cross: svg('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
  signature: svg(
    '<path d="M3 17.5c2.6 0 3.2-11 5.6-11 1.7 0 1.3 7.6 3.1 7.6 1.5 0 1.6-4.2 3-4.2 1.2 0 1.1 3.2 2.4 3.2.9 0 1.3-1.1 1.9-1.1"/><path d="M3 20.8h18"/>',
  ),
  download: svg('<path d="M12 4v10"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>'),
  undo: svg('<path d="M9 7 4.5 11.5 9 16"/><path d="M4.5 11.5H14a5.5 5.5 0 0 1 0 11h-3"/>'),
  redo: svg('<path d="m15 7 4.5 4.5L15 16"/><path d="M19.5 11.5H10a5.5 5.5 0 0 0 0 11h3"/>'),
  trash: svg('<path d="M4.5 6.5h15"/><path d="M9.5 6.5V4.8h5v1.7"/><path d="M6.5 6.5 7.4 20h9.2l.9-13.5"/>'),
  zoomIn: svg('<circle cx="11" cy="11" r="6.5"/><path d="M11 8.5v5"/><path d="M8.5 11h5"/><path d="m15.8 15.8 4 4"/>'),
  zoomOut: svg('<circle cx="11" cy="11" r="6.5"/><path d="M8.5 11h5"/><path d="m15.8 15.8 4 4"/>'),
  close: svg('<path d="M6.5 6.5 17.5 17.5"/><path d="M17.5 6.5 6.5 17.5"/>'),
  grip: svg('<circle cx="9.5" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="14.5" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="9.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9.5" cy="17.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="14.5" cy="17.5" r="1.3" fill="currentColor" stroke="none"/>'),
  folder: svg('<path d="M3.5 6.8h6l1.8 2.2h9.2v10.2h-17z"/>'),
} as const;

export type IconName = keyof typeof ICONS;

/**
 * Large tile glyphs for the primary tools. Heavier strokes and a bigger
 * viewBox than the utility icons, to match the toolbar reference: a bold serif
 * A, a weighty check and cross, and a cursive signature flourish.
 */
const tile = (body: string): string =>
  `<svg viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const TILE_ICONS = {
  // Drawn as a real glyph rather than paths — a stroked triangle never reads
  // as a serif "A", and the reference is unmistakably a typographic letterform.
  text:
    '<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">' +
    '<text x="14" y="23" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif"' +
    ' font-weight="700" font-size="27" fill="currentColor">A</text></svg>',
  check: tile('<path d="M4.5 15.2 11 21.8 23.5 6.6"/>'),
  cross: tile('<path d="M6.5 6.5 21.5 21.5"/><path d="M21.5 6.5 6.5 21.5"/>'),
  // A cursive lower-case "n": tall looped entry stroke, an arch, then a
  // rising swash tail — the handwriting shape from the design reference.
  signature:
    '<svg viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="currentColor"' +
    ' stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5.6 21.8C4.8 15.2 6.1 8.6 9.3 6.7c2.4-1.4 3.4 1 2.1 4' +
    '-1.3 3-2.7 5.8-2.5 8 .2 2.2 2.1 2 3.6-.6 1.6-2.8 3.4-5.6 5.6-5.4' +
    ' 2 .2 1.6 3.6 1.2 5.8-.4 2.2 1.2 3 2.8 1.2 1.4-1.6 2.3-4 2.8-6.6"/></svg>',
  download: tile('<path d="M14 4.5v13"/><path d="m8.4 12.4 5.6 5.6 5.6-5.6"/><path d="M5 23h18"/>'),
} as const;

export type TileIconName = keyof typeof TILE_ICONS;
