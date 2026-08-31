/**
 * Annotation model.
 *
 * COORDINATE SYSTEM — read this before touching any geometry.
 *
 * Every annotation stores its position in *normalized view space*: x and y are
 * fractions (0..1) of the page's rendered box, measured from its top-left, with
 * the page's own /Rotate already applied. Sizes are fractions of the page
 * height.
 *
 * Why not PDF points? Because normalized view space is:
 *   - zoom-independent   → px = x * canvas.width, at any scale, no rescaling pass
 *   - rotation-agnostic  → the annotation sits where the user *saw* it
 *   - resolution-safe    → HiDPI backing stores don't leak into stored data
 *
 * The single conversion to PDF user space happens once, at export, through
 * pdf.js's `viewport.convertToPdfPoint()` (see core/geometry.ts). That is the
 * only place the two frames meet, and it handles /Rotate, /MediaBox offsets and
 * the y-axis flip for free.
 */

export type ToolId = 'select' | 'text' | 'check' | 'cross' | 'signature';

export interface Point {
  x: number;
  y: number;
}

interface AnnotationBase {
  id: string;
  /** 0-based page index. */
  page: number;
  /** Top-left anchor, normalized view space. */
  x: number;
  y: number;
  /** sRGB hex, e.g. "#111827". */
  color: string;
  createdAt: number;
}

export interface TextAnnotation extends AnnotationBase {
  kind: 'text';
  text: string;
  /** Font size as a fraction of page height (keeps text stable across zoom). */
  size: number;
  fontFamily: FontFamilyId;
  bold: boolean;
  italic: boolean;
}

export interface MarkAnnotation extends AnnotationBase {
  kind: 'check' | 'cross';
  /** Glyph box height as a fraction of page height. */
  size: number;
  /** Stroke width as a fraction of page height. */
  weight: number;
}

export interface SignatureAnnotation extends AnnotationBase {
  kind: 'signature';
  /** PNG data URL, trimmed to the ink bounding box. */
  dataUrl: string;
  /** Both normalized: width against page width, height against page height. */
  width: number;
  height: number;
}

export type Annotation = TextAnnotation | MarkAnnotation | SignatureAnnotation;

export type FontFamilyId = 'helvetica' | 'times' | 'courier';

export interface SavedSignature {
  id: string;
  dataUrl: string;
  /** Intrinsic pixel size of the trimmed PNG — used to preserve aspect ratio. */
  pxWidth: number;
  pxHeight: number;
  createdAt: number;
}

export interface Preferences {
  color: string;
  fontFamily: FontFamilyId;
  /** Text size as a fraction of page height. ~0.018 ≈ 14pt on Letter. */
  textSize: number;
  markSize: number;
  bold: boolean;
  italic: boolean;
  /** Hijack .pdf navigations and open them here instead of Chrome's viewer. */
  autoOpen: boolean;
}

export const DEFAULT_PREFS: Preferences = {
  color: '#1f2937',
  fontFamily: 'helvetica',
  textSize: 0.018,
  markSize: 0.028,
  bold: false,
  italic: false,
  autoOpen: false,
};
