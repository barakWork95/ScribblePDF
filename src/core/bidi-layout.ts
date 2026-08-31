/**
 * Bidirectional text layout for PDF export.
 *
 * PDF has no concept of text direction: glyphs are painted in the order given,
 * at the positions given. Anything bidirectional has to be resolved before it
 * reaches `drawText`. This module turns one logical-order line into a list of
 * spans that can be painted strictly left-to-right.
 *
 * Two things are resolved here:
 *
 * 1. **Direction.** The Unicode Bidi Algorithm (via bidi-js) assigns an
 *    embedding level per character; runs of equal level are reordered by rule
 *    L2 into visual order.
 *
 * 2. **Font coverage.** Noto Sans Hebrew is a Hebrew-only face — 148 code
 *    points, no Latin, no digits, no ASCII punctuation. A string like `ע"י`
 *    therefore needs *two* fonts, so each direction run is further split into
 *    spans by which font can actually render the characters.
 *
 * The one subtlety worth understanding: fontkit (inside pdf-lib) runs its own
 * shaper, and for a Hebrew-script span it reverses the glyphs itself. So
 * Hebrew spans must be handed to it in LOGICAL order. Spans drawn with a Latin
 * font get no such treatment, so neutral characters (punctuation, dashes,
 * spaces) sitting inside an RTL run must be reversed and mirrored here.
 * Getting this backwards double-reverses the text and is invisible until you
 * look at rendered output — see scripts/test-bidi.mjs, which pins the
 * behaviour against bidi-js's own reference reordering.
 */
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

/** Which font can render a character. */
export type CharClass = 'standard' | 'hebrew' | 'both';

export interface TextSpan {
  /** Exactly the string to hand to pdf-lib's drawText — already ordered. */
  text: string;
  /** True when the embedded Hebrew face must be used for this span. */
  hebrew: boolean;
}

interface LevelRun {
  start: number;
  end: number;
  level: number;
}

/**
 * Resolve one line into paint-order spans.
 *
 * `classify` reports, per character, which font can render it. Characters both
 * fonts cover (spaces, mostly) attach to the surrounding span so that words
 * are not fragmented across fonts for no reason.
 */
export function layoutLine(line: string, classify: (ch: string) => CharClass): TextSpan[] {
  if (line === '') return [];

  // 'auto' = base direction from the first strong character, which is exactly
  // what the on-screen text element does via dir="auto". These two must agree
  // or a mixed line lands in a different order on paper than on screen.
  const { levels } = bidi.getEmbeddingLevels(line, 'auto');
  const runs = reorderRuns(levelRuns(levels, line.length));

  const spans: TextSpan[] = [];
  for (const run of runs) {
    const rtl = run.level % 2 === 1;
    const parts = fontSpans(line.slice(run.start, run.end), classify);
    if (rtl) parts.reverse();
    for (const part of parts) {
      spans.push({
        // Hebrew spans: fontkit reverses them, so keep logical order.
        // Everything else inside an RTL run must be reversed here.
        text: part.hebrew || !rtl ? part.text : mirrorAndReverse(part.text),
        hebrew: part.hebrew,
      });
    }
  }
  return spans;
}

/** Maximal runs of equal embedding level, in logical order. */
function levelRuns(levels: Uint8Array | number[], length: number): LevelRun[] {
  const runs: LevelRun[] = [];
  let start = 0;
  for (let i = 1; i <= length; i++) {
    if (i === length || levels[i] !== levels[start]) {
      runs.push({ start, end: i, level: levels[start] ?? 0 });
      start = i;
    }
  }
  return runs;
}

/**
 * Unicode Bidi Algorithm rule L2: from the highest level down to the lowest
 * odd level, reverse any contiguous sequence of runs at or above that level.
 */
function reorderRuns(runs: LevelRun[]): LevelRun[] {
  if (runs.length < 2) return runs;

  let maxLevel = 0;
  let minOdd = Number.POSITIVE_INFINITY;
  for (const run of runs) {
    if (run.level > maxLevel) maxLevel = run.level;
    if (run.level % 2 === 1 && run.level < minOdd) minOdd = run.level;
  }
  if (minOdd === Number.POSITIVE_INFINITY) return runs; // nothing RTL

  const out = [...runs];
  for (let level = maxLevel; level >= minOdd; level--) {
    for (let i = 0; i < out.length; i++) {
      if ((out[i]?.level ?? 0) < level) continue;
      let j = i;
      while (j + 1 < out.length && (out[j + 1]?.level ?? 0) >= level) j++;
      const segment = out.slice(i, j + 1).reverse();
      out.splice(i, segment.length, ...segment);
      i = j;
    }
  }
  return out;
}

/**
 * Split a run into spans by font coverage. Characters both fonts cover follow
 * the surrounding span; a leading run of such characters adopts the font of
 * the first character that actually needs one.
 */
function fontSpans(
  text: string,
  classify: (ch: string) => CharClass,
): Array<{ text: string; hebrew: boolean }> {
  const chars = [...text];
  const classes = chars.map(classify);

  const spans: Array<{ text: string; hebrew: boolean }> = [];
  let current: { text: string; hebrew: boolean } | null = null;

  for (let i = 0; i < chars.length; i++) {
    const cls = classes[i]!;
    let hebrew: boolean;
    if (cls === 'both') {
      hebrew = current ? current.hebrew : lookaheadHebrew(classes, i);
    } else {
      hebrew = cls === 'hebrew';
    }
    if (!current || current.hebrew !== hebrew) {
      current = { text: '', hebrew };
      spans.push(current);
    }
    current.text += chars[i]!;
  }
  return spans;
}

/** First decisive class at or after `from`; defaults to the standard font. */
function lookaheadHebrew(classes: CharClass[], from: number): boolean {
  for (let i = from + 1; i < classes.length; i++) {
    const cls = classes[i];
    if (cls === 'hebrew') return true;
    if (cls === 'standard') return false;
  }
  return false;
}

/** Bidi rule L4: reverse, mirroring paired characters such as brackets. */
function mirrorAndReverse(text: string): string {
  return [...text]
    .reverse()
    .map((ch) => bidi.getMirroredCharacter(ch) ?? ch)
    .join('');
}

/**
 * Reference visual ordering, used by the test suite as ground truth. Not used
 * at export time — the span pipeline must reproduce this independently.
 */
export function referenceVisualOrder(line: string): string {
  const embeddingLevels = bidi.getEmbeddingLevels(line);
  return bidi.getReorderedString(line, embeddingLevels);
}
