/**
 * Shared text metrics for screen and export.
 *
 * Dependency-free on purpose: the annotation layer needs these on every render,
 * while the exporter (pdf-lib + fontkit) is loaded lazily. Keeping metrics here
 * is what lets those two live in separate bundle chunks.
 *
 * WHY METRICS ARE MEASURED, NOT TABULATED
 *
 * The baseline of a line of text has to be computed identically on screen and
 * on paper, and that depends on the ascent/descent of the font the *browser*
 * actually resolved. `"Helvetica"` resolves to Helvetica on macOS, Arial on
 * Windows, and Liberation Sans or DejaVu Sans on Linux — all with different
 * hhea metrics. A hardcoded table is therefore only correct on the platform it
 * was tuned on, and text drifts off its on-screen baseline everywhere else.
 *
 * So we ask the browser: render a probe glyph and read
 * `TextMetrics.fontBoundingBoxAscent/Descent`, which report the resolved font's
 * own metrics. The table below survives only as a fallback for the case where
 * those fields are unavailable or nonsensical.
 */
import type { FontFamilyId } from './types';

/**
 * Line box ratio used by the on-screen text element. Export reads it back to
 * place the PDF baseline, so screen and paper agree by construction.
 */
export const LINE_HEIGHT = 1.2;

/** The bundled Hebrew face, registered via @font-face in viewer.css. */
export const HEBREW_FAMILY = 'PA Noto Sans Hebrew';

export interface FontMetrics {
  /** Ascent above the baseline, in em. */
  ascent: number;
  /** Descent below the baseline, in em. */
  descent: number;
}

/** macOS-resolved hhea values; used only when measurement is unavailable. */
const FALLBACK: Record<FontFamilyId, FontMetrics> = {
  helvetica: { ascent: 0.905, descent: 0.212 },
  times: { ascent: 0.891, descent: 0.216 },
  courier: { ascent: 0.833, descent: 0.3 },
};

/** Noto Sans Hebrew: unitsPerEm 1000, ascent 1068, descent -292. */
const HEBREW_FALLBACK: FontMetrics = { ascent: 1.068, descent: 0.292 };

/** Large enough that rounding in the returned metrics is irrelevant. */
const PROBE_SIZE = 100;

const metricsCache = new Map<string, FontMetrics>();
let probeContext: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (probeContext === undefined) {
    probeContext = document.createElement('canvas').getContext('2d');
  }
  return probeContext;
}

export function cssFontShorthand(
  stack: string,
  bold: boolean,
  italic: boolean,
  size = PROBE_SIZE,
): string {
  return `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${size}px ${stack}`;
}

/**
 * Measure the resolved font for a CSS stack. `probe` must contain a character
 * the intended face actually has, or the browser resolves further down the
 * stack and reports the wrong font's metrics.
 */
export function measureMetrics(
  stack: string,
  bold: boolean,
  italic: boolean,
  probe: string,
  fallback: FontMetrics,
): FontMetrics {
  const key = `${stack}|${bold ? 'b' : 'r'}|${italic ? 'i' : 'r'}|${probe}`;
  const cached = metricsCache.get(key);
  if (cached) return cached;

  let result = fallback;
  const ctx = context();
  if (ctx) {
    ctx.font = cssFontShorthand(stack, bold, italic);
    const m = ctx.measureText(probe);
    const ascent = m.fontBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent;
    if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent > 0) {
      result = { ascent: ascent / PROBE_SIZE, descent: descent / PROBE_SIZE };
    }
  }
  metricsCache.set(key, result);
  return result;
}

export interface BaselineOptions {
  bold?: boolean;
  italic?: boolean;
  /** True when the line contains Hebrew drawn with the bundled face. */
  hebrew?: boolean;
}

/**
 * Distance from the top of a line box to its baseline, in em.
 *
 * With a fixed `line-height`, the browser centres the content area within the
 * line box; the content area is as tall as the largest ascent and descent among
 * the fonts used on that line, which is why a mixed Hebrew/Latin line takes the
 * max of both faces.
 */
export function baselineRatio(family: FontFamilyId, options: BaselineOptions = {}): number {
  const { bold = false, italic = false, hebrew = false } = options;

  const base = measureMetrics(cssFamily(family), bold, italic, 'Hxg', FALLBACK[family]);
  let ascent = base.ascent;
  let descent = base.descent;

  if (hebrew) {
    const heb = measureMetrics(`"${HEBREW_FAMILY}"`, bold, italic, 'א', HEBREW_FALLBACK);
    ascent = Math.max(ascent, heb.ascent);
    descent = Math.max(descent, heb.descent);
  }

  return (LINE_HEIGHT - (ascent + descent)) / 2 + ascent;
}

/**
 * Load the bundled Hebrew face before anything measures it.
 *
 * `@font-face` fonts are fetched lazily, so measuring before the file lands
 * silently returns the fallback font's metrics and caches them. Call once at
 * startup; the cache is cleared afterwards so nothing measured too early
 * survives.
 */
export async function warmUpFontMetrics(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(cssFontShorthand(`"${HEBREW_FAMILY}"`, false, false), 'א'),
      document.fonts.load(cssFontShorthand(`"${HEBREW_FAMILY}"`, true, false), 'א'),
    ]);
    await document.fonts.ready;
  } catch {
    /* metrics fall back to the table; not worth failing startup over */
  }
  metricsCache.clear();
}

/**
 * CSS stack for on-screen text. The bundled Hebrew face is appended so the
 * browser falls through to it for Hebrew exactly where the exporter switches
 * fonts — that is what keeps screen and paper in agreement.
 */
export function cssFamily(f: FontFamilyId): string {
  const hebrew = `"${HEBREW_FAMILY}"`;
  switch (f) {
    case 'times':
      return `"Times New Roman", Times, ${hebrew}, serif`;
    case 'courier':
      return `"Courier New", Courier, ${hebrew}, monospace`;
    default:
      return `Helvetica, Arial, ${hebrew}, sans-serif`;
  }
}
