/**
 * The one place normalized view space and PDF user space meet.
 *
 * Everything else in the app works in normalized view space (see types.ts).
 * Only the exporter crosses the boundary, and it does so exclusively through
 * these helpers so that /Rotate, /MediaBox offsets and the y-axis flip are
 * handled in exactly one place.
 */

/** Structural subset of pdf.js's PageViewport that we actually depend on. */
export interface Viewport {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): [number, number];
}

export interface Basis {
  /** PDF user-space point of the page box's top-left corner. */
  origin: [number, number];
  /** Unit vector: +1 view-x (rightwards on screen) expressed in user space. */
  right: [number, number];
  /** Unit vector: +1 view-y (downwards on screen) expressed in user space. */
  down: [number, number];
  /** Rotation, in degrees, that makes user-space content read horizontally. */
  angleDeg: number;
}

/**
 * Derive the view→user basis empirically from the viewport rather than
 * reimplementing the rotation matrix. Works for /Rotate 0/90/180/270 and for
 * any non-zero /MediaBox origin without special-casing.
 *
 * `viewport` must be built at scale 1, so the basis vectors come out unit
 * length and normalized sizes convert straight to points.
 */
export function basisOf(viewport: Viewport): Basis {
  const origin = viewport.convertToPdfPoint(0, 0);
  const px = viewport.convertToPdfPoint(1, 0);
  const py = viewport.convertToPdfPoint(0, 1);
  const right: [number, number] = [px[0] - origin[0], px[1] - origin[1]];
  const down: [number, number] = [py[0] - origin[0], py[1] - origin[1]];
  return {
    origin,
    right,
    down,
    angleDeg: (Math.atan2(right[1], right[0]) * 180) / Math.PI,
  };
}

/** Normalized view coords (0..1) → PDF user-space point. */
export function toPdfPoint(viewport: Viewport, nx: number, ny: number): [number, number] {
  return viewport.convertToPdfPoint(nx * viewport.width, ny * viewport.height);
}

/** Walk `steps` view-space units along a basis vector from a user-space point. */
export function along(
  p: [number, number],
  v: [number, number],
  steps: number,
): [number, number] {
  return [p[0] + v[0] * steps, p[1] + v[1] * steps];
}

/**
 * Glyph outlines for the check and cross stamps, as polylines in a unit box
 * (0..1, y down). Shared by the on-screen SVG renderer and the pdf-lib
 * exporter so what you see is literally the same path that gets burned in.
 */
export const GLYPHS: Record<'check' | 'cross', Array<Array<[number, number]>>> = {
  check: [
    [
      [0.06, 0.52],
      [0.36, 0.84],
      [0.94, 0.14],
    ],
  ],
  cross: [
    [
      [0.1, 0.1],
      [0.9, 0.9],
    ],
    [
      [0.9, 0.1],
      [0.1, 0.9],
    ],
  ],
};

/** "#1f2937" | "#abc" → { r, g, b } in 0..1, as pdf-lib's rgb() expects. */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n) || h.length !== 6) return { r: 0, g: 0, b: 0 };
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
