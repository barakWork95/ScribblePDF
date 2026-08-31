/**
 * Export: burn annotations into the original PDF binary with pdf-lib.
 *
 * We modify the *original* bytes rather than re-encoding pdf.js's raster
 * output, so the exported file keeps its real text layer, vectors, bookmarks
 * and file size. Annotations are appended as new content on each page.
 *
 * Everything runs in the tab. The only fetches are for font files packaged
 * inside the extension.
 */
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import type { PDFFont, PDFImage, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type {
  Annotation,
  FontFamilyId,
  MarkAnnotation,
  SignatureAnnotation,
  TextAnnotation,
} from './types';
import type { Viewport } from './geometry';
import { GLYPHS, along, basisOf, hexToRgb01, toPdfPoint } from './geometry';
import { layoutLine } from './bidi-layout';
import type { CharClass } from './bidi-layout';
import { LINE_HEIGHT, baselineRatio, cssFamily, cssFontShorthand } from './text-style';

const STANDARD_FONTS: Record<FontFamilyId, Record<string, StandardFonts>> = {
  helvetica: {
    rr: StandardFonts.Helvetica,
    br: StandardFonts.HelveticaBold,
    ri: StandardFonts.HelveticaOblique,
    bi: StandardFonts.HelveticaBoldOblique,
  },
  times: {
    rr: StandardFonts.TimesRoman,
    br: StandardFonts.TimesRomanBold,
    ri: StandardFonts.TimesRomanItalic,
    bi: StandardFonts.TimesRomanBoldItalic,
  },
  courier: {
    rr: StandardFonts.Courier,
    br: StandardFonts.CourierBold,
    ri: StandardFonts.CourierOblique,
    bi: StandardFonts.CourierBoldOblique,
  },
};

const HEBREW_FONT_URLS = {
  regular: 'vendor/fonts/NotoSansHebrew-Regular.ttf',
  bold: 'vendor/fonts/NotoSansHebrew-Bold.ttf',
} as const;

/**
 * The 14 standard PDF fonts are WinAnsi-encoded and cannot represent anything
 * outside Latin-1. Hebrew is handled by embedding Noto Sans Hebrew; anything
 * still outside both faces (Arabic, CJK, emoji) falls back to rasterization.
 */
const WINANSI = /^[\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]*$/;

export const isWinAnsiSafe = (s: string): boolean => WINANSI.test(s);

export { LINE_HEIGHT, baselineRatio, cssFamily };

// ---------------------------------------------------------------- font load

/** Module-level caches: the font files never change within a session. */
const fontBytesCache = new Map<string, Promise<Uint8Array>>();
const coverageCache = new Map<string, Promise<Set<number>>>();

function hebrewFontBytes(bold: boolean): Promise<Uint8Array> {
  const key = bold ? 'bold' : 'regular';
  let pending = fontBytesCache.get(key);
  if (!pending) {
    // Packaged inside the extension — this is not a network request.
    pending = fetch(chrome.runtime.getURL(HEBREW_FONT_URLS[key]))
      .then((res) => {
        if (!res.ok) throw new Error(`font ${key}: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => new Uint8Array(buf));
    fontBytesCache.set(key, pending);
  }
  return pending;
}

/**
 * Code points the Hebrew face can render. Parsed with fontkit directly rather
 * than reaching into pdf-lib's embedder internals.
 */
function hebrewCoverage(bold: boolean): Promise<Set<number>> {
  const key = bold ? 'bold' : 'regular';
  let pending = coverageCache.get(key);
  if (!pending) {
    pending = hebrewFontBytes(bold).then((bytes) => {
      const parsed = fontkit.create(bytes as never) as unknown as { characterSet: number[] };
      return new Set(parsed.characterSet);
    });
    coverageCache.set(key, pending);
  }
  return pending;
}

/**
 * Per-export font cache. Embedding the same face twice would duplicate it in
 * the output file, so every lookup goes through here.
 */
class FontProvider {
  private standardCache = new Map<string, Promise<PDFFont>>();
  private hebrewCache = new Map<string, Promise<PDFFont>>();

  constructor(private doc: PDFDocument) {}

  standard(family: FontFamilyId, bold: boolean, italic: boolean): Promise<PDFFont> {
    const key = `${family}:${bold ? 'b' : 'r'}${italic ? 'i' : 'r'}`;
    let pending = this.standardCache.get(key);
    if (!pending) {
      const name = STANDARD_FONTS[family][`${bold ? 'b' : 'r'}${italic ? 'i' : 'r'}`]!;
      pending = this.doc.embedFont(name);
      this.standardCache.set(key, pending);
    }
    return pending;
  }

  hebrew(bold: boolean): Promise<PDFFont> {
    const key = bold ? 'bold' : 'regular';
    let pending = this.hebrewCache.get(key);
    if (!pending) {
      pending = hebrewFontBytes(bold).then(async (bytes) => {
        try {
          // Subsetting keeps the output small: a few Hebrew glyphs instead of
          // the whole 27 KB face.
          return await this.doc.embedFont(bytes, { subset: true });
        } catch (err) {
          console.warn('[scribblepdf] font subsetting failed, embedding in full', err);
          return this.doc.embedFont(bytes);
        }
      });
      this.hebrewCache.set(key, pending);
    }
    return pending;
  }
}

// -------------------------------------------------------------------- export

export interface ExportInput {
  /** Pristine bytes of the source document. */
  originalBytes: Uint8Array;
  annotations: Annotation[];
  /** Per page index: the scale-1 pdf.js viewport used as the reference frame. */
  viewports: Viewport[];
}

export async function exportPdf({
  originalBytes,
  annotations,
  viewports,
}: ExportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  doc.registerFontkit(fontkit);

  const fonts = new FontProvider(doc);
  const imageCache = new Map<string, Promise<PDFImage>>();
  const getImage = (dataUrl: string): Promise<PDFImage> => {
    let pending = imageCache.get(dataUrl);
    if (!pending) {
      pending = doc.embedPng(dataUrl);
      imageCache.set(dataUrl, pending);
    }
    return pending;
  };

  const pages = doc.getPages();

  // Draw in creation order so later annotations sit on top, matching the
  // on-screen stacking.
  const ordered = [...annotations].sort((a, b) => a.createdAt - b.createdAt);

  for (const ann of ordered) {
    const page = pages[ann.page];
    const viewport = viewports[ann.page];
    if (!page || !viewport) continue;

    switch (ann.kind) {
      case 'text':
        await drawText(ann, page, viewport, fonts, getImage);
        break;
      case 'check':
      case 'cross':
        drawMark(ann, page, viewport);
        break;
      case 'signature':
        await drawSignature(ann, page, viewport, getImage);
        break;
    }
  }

  return doc.save({ useObjectStreams: true });
}

// ---------------------------------------------------------------------- text

async function drawText(
  ann: TextAnnotation,
  page: PDFPage,
  viewport: Viewport,
  fonts: FontProvider,
  getImage: (dataUrl: string) => Promise<PDFImage>,
): Promise<void> {
  const lines = ann.text.split('\n');
  if (lines.every((line) => line.trim() === '')) return;

  const sizePt = ann.size * viewport.height;
  const covered = await hebrewCoverage(ann.bold);

  const classify = (ch: string): CharClass => {
    const standard = isWinAnsiSafe(ch);
    const hebrew = covered.has(ch.codePointAt(0) ?? 0);
    if (standard && hebrew) return 'both';
    return hebrew ? 'hebrew' : 'standard';
  };

  // Anything neither face can draw (Arabic, CJK, emoji) goes to the raster
  // path rather than silently dropping glyphs.
  const renderable = [...ann.text].every(
    (ch) => ch === '\n' || isWinAnsiSafe(ch) || covered.has(ch.codePointAt(0) ?? 0),
  );
  if (!renderable) {
    await drawTextAsRaster(ann, page, viewport, sizePt, getImage);
    return;
  }

  const { down, right, angleDeg } = basisOf(viewport);
  const { r, g, b } = hexToRgb01(ann.color);
  const color = rgb(r, g, b);
  const topLeft = toPdfPoint(viewport, ann.x, ann.y);
  const usesHebrew = [...ann.text].some((ch) => classify(ch) === 'hebrew');
  const firstBaseline =
    sizePt * baselineRatio(ann.fontFamily, { bold: ann.bold, italic: ann.italic, hebrew: usesHebrew });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '') continue;

    const lineOrigin = along(topLeft, down, firstBaseline + i * sizePt * LINE_HEIGHT);
    let advance = 0;

    // Spans arrive in paint order, left to right, already direction-resolved.
    for (const span of layoutLine(line, classify)) {
      const font = span.hebrew
        ? await fonts.hebrew(ann.bold)
        : await fonts.standard(ann.fontFamily, ann.bold, ann.italic);
      const [x, y] = along(lineOrigin, right, advance);
      page.drawText(span.text, {
        x,
        y,
        size: sizePt,
        font,
        color,
        rotate: degrees(angleDeg),
      });
      advance += font.widthOfTextAtSize(span.text, sizePt);
    }
  }
}

/**
 * Last-resort fallback for scripts neither face covers: let the browser lay
 * the text out (shaping, bidi, system font fallback) and embed the result as
 * an image. Visually correct, but not selectable in the output.
 */
async function drawTextAsRaster(
  ann: TextAnnotation,
  page: PDFPage,
  viewport: Viewport,
  sizePt: number,
  getImage: (dataUrl: string) => Promise<PDFImage>,
): Promise<void> {
  const raster = rasterizeText(ann, sizePt);
  if (!raster) return;
  const { down, angleDeg } = basisOf(viewport);
  const topLeft = toPdfPoint(viewport, ann.x, ann.y);
  const [x, y] = along(topLeft, down, raster.heightPt);
  const img = await getImage(raster.dataUrl);
  page.drawImage(img, {
    x,
    y,
    width: raster.widthPt,
    height: raster.heightPt,
    rotate: degrees(angleDeg),
  });
}

/** 4x supersampling keeps rasterized text sharp when the PDF is zoomed in. */
const RASTER_SCALE = 4;

function rasterizeText(
  ann: TextAnnotation,
  sizePt: number,
): { dataUrl: string; widthPt: number; heightPt: number } | null {
  const lines = ann.text.split('\n');
  const px = sizePt * RASTER_SCALE;
  const cssFont = cssFontShorthand(cssFamily(ann.fontFamily), ann.bold, ann.italic, px);

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  measure.font = cssFont;
  const widthPx = Math.max(1, ...lines.map((l) => measure.measureText(l).width));
  const lineHeightPx = px * LINE_HEIGHT;
  const heightPx = lineHeightPx * lines.length;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(widthPx);
  canvas.height = Math.ceil(heightPx);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = cssFont;
  ctx.fillStyle = ann.color;
  ctx.textBaseline = 'alphabetic';
  // Measured from this exact context: the raster path handles scripts we have
  // no bundled face for, so only the browser knows which font it resolved.
  const probe = measure.measureText(ann.text || 'Hxg');
  const ascent = Number.isFinite(probe.fontBoundingBoxAscent) ? probe.fontBoundingBoxAscent : px * 0.9;
  const descent = Number.isFinite(probe.fontBoundingBoxDescent) ? probe.fontBoundingBoxDescent : px * 0.21;
  const baseline = (lineHeightPx - (ascent + descent)) / 2 + ascent;
  lines.forEach((line, i) => ctx.fillText(line, 0, baseline + i * lineHeightPx));

  return {
    dataUrl: canvas.toDataURL('image/png'),
    widthPt: widthPx / RASTER_SCALE,
    heightPt: heightPx / RASTER_SCALE,
  };
}

// --------------------------------------------------------------- marks / sig

/**
 * Check and cross are drawn as line segments straight from the shared unit
 * glyph in geometry.ts. Converting each vertex through the viewport means the
 * marks need no rotation math at all — they land wherever the user saw them,
 * on any page rotation.
 */
function drawMark(ann: MarkAnnotation, page: PDFPage, viewport: Viewport): void {
  const { r, g, b } = hexToRgb01(ann.color);
  const boxH = ann.size * viewport.height;
  // Unit glyphs are square, so the box width is the same in *view* units.
  const boxW = boxH;
  const thickness = Math.max(0.5, ann.weight * viewport.height);

  for (const stroke of GLYPHS[ann.kind]) {
    for (let i = 0; i < stroke.length - 1; i++) {
      const a = stroke[i]!;
      const c = stroke[i + 1]!;
      const p1 = toPdfPoint(
        viewport,
        ann.x + (a[0] * boxW) / viewport.width,
        ann.y + (a[1] * boxH) / viewport.height,
      );
      const p2 = toPdfPoint(
        viewport,
        ann.x + (c[0] * boxW) / viewport.width,
        ann.y + (c[1] * boxH) / viewport.height,
      );
      page.drawLine({
        start: { x: p1[0], y: p1[1] },
        end: { x: p2[0], y: p2[1] },
        thickness,
        color: rgb(r, g, b),
        lineCap: 1, // round — matches the SVG stroke-linecap on screen
      });
    }
  }
}

async function drawSignature(
  ann: SignatureAnnotation,
  page: PDFPage,
  viewport: Viewport,
  getImage: (dataUrl: string) => Promise<PDFImage>,
): Promise<void> {
  const img = await getImage(ann.dataUrl);
  const { down, angleDeg } = basisOf(viewport);
  const wPt = ann.width * viewport.width;
  const hPt = ann.height * viewport.height;
  const topLeft = toPdfPoint(viewport, ann.x, ann.y);
  // drawImage anchors at the bottom-left of the rotated frame.
  const [x, y] = along(topLeft, down, hPt);
  page.drawImage(img, { x, y, width: wPt, height: hPt, rotate: degrees(angleDeg) });
}

/** Trigger a local download. Uses a blob URL — nothing is uploaded. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on the next tick; revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
