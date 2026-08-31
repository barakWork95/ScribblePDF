/**
 * Regression test for src/core/bidi-layout.ts.
 *
 * Strategy: the span pipeline must reproduce bidi-js's own reference visual
 * ordering. We simulate what fontkit does downstream — it reverses the glyphs
 * of a Hebrew-script span — then concatenate the painted spans left to right
 * and compare against `getReorderedString`.
 *
 * This catches the failure mode that is otherwise invisible until you look at
 * a rendered PDF: double-reversed text.
 *
 *   node scripts/test-bidi.mjs
 */
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname) + '/..';

// Bundle the module under test so it runs in Node exactly as it ships.
const { outputFiles } = await esbuild.build({
  entryPoints: [`${root}/src/core/bidi-layout.ts`],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
  mainFields: ['module', 'main'],
});
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64')
);

// Real coverage from the shipped font files — not a hand-written guess.
const hebrew = new Set(
  fontkit.create(readFileSync(`${root}/public/fonts/NotoSansHebrew-Regular.ttf`)).characterSet,
);
const WINANSI = /^[\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]$/;

function classify(ch) {
  const std = WINANSI.test(ch);
  const heb = hebrew.has(ch.codePointAt(0));
  if (std && heb) return 'both';
  if (heb) return 'hebrew';
  return 'standard';
}

/** Simulate fontkit: it reverses glyph order for an RTL-script span. */
const paint = (spans) =>
  spans.map((s) => (s.hebrew ? [...s.text].reverse().join('') : s.text)).join('');

const CASES = [
  ['pure latin', 'Approved - B. Vadei'],
  ['pure hebrew', 'אושר ונבדק'],
  ['hebrew with gershayim', 'אושר ע"י ברק'],
  ['hebrew + latin + digits', 'אושר ע"י ברק — OK 42'],
  ['latin first, hebrew after', 'Invoice 220 — חשבונית מס'],
  ['digits inside hebrew', 'סכום 1,250 שקלים'],
  ['hebrew with brackets', 'הערה (חשוב) לסיום'],
  ['hebrew punctuation', 'ד״ר כהן, ז״ל'],
  ['trailing/leading spaces', '  שלום עולם  '],
  ['single hebrew word', 'תקין'],
  ['newline-free mixed', 'Ref: 7A/2026 — מאושר'],
  ['hyphenated hebrew', 'בן-גוריון 12'],
];

let failed = 0;
for (const [name, line] of CASES) {
  const expected = mod.referenceVisualOrder(line);
  const actual = paint(mod.layoutLine(line, classify));
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

// Font-coverage assertions: no span may contain a character its font lacks.
for (const [name, line] of CASES) {
  for (const span of mod.layoutLine(line, classify)) {
    for (const ch of span.text) {
      const covered = span.hebrew ? hebrew.has(ch.codePointAt(0)) : WINANSI.test(ch);
      if (!covered) {
        failed++;
        console.log(
          `FAIL  coverage (${name}): ${JSON.stringify(ch)} in ${span.hebrew ? 'hebrew' : 'standard'} span`,
        );
      }
    }
  }
}

console.log(failed === 0 ? '\nall bidi layout tests passed' : `\n${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
