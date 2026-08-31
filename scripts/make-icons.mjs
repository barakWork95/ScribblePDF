/**
 * Rasterise the ScribblePDF icon SVGs into the PNG sizes the manifest needs.
 *
 *   npm run icons
 *
 * The SVGs in assets/ are the single source of truth for the artwork; the PNGs
 * in public/icons/ are build output that happens to be committed (Chrome needs
 * real PNGs, and reviewers should see what ships).
 *
 * Two sources, not one scaled artwork: the pen, the document fold and the
 * signature loop are sub-pixel noise below ~64px, so small sizes are drawn
 * separately rather than downsampled into mud. See the comments in each SVG.
 */
import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname) + '/..';
const SRC = path.join(root, 'assets');
const OUT = path.join(root, 'public/icons');

/** Which artwork drives which size. */
const TARGETS = [
  { size: 16, source: 'icon-small.svg' },
  { size: 32, source: 'icon-small.svg' },
  { size: 48, source: 'icon-small.svg' },
  { size: 128, source: 'icon.svg' },
];

/** A `--` inside an XML comment is malformed and makes the SVG fail to parse. */
function assertWellFormedComments(name, svg) {
  for (const [, body] of svg.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (body.includes('--')) {
      throw new Error(`${name}: illegal "--" inside an XML comment`);
    }
  }
}

await mkdir(OUT, { recursive: true });

const cache = new Map();
for (const { size, source } of TARGETS) {
  let svg = cache.get(source);
  if (!svg) {
    svg = await readFile(path.join(SRC, source), 'utf8');
    assertWellFormedComments(source, svg);
    cache.set(source, svg);
  }

  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    // Transparent outside the rounded card, so the icon sits on any chrome.
    background: 'rgba(0,0,0,0)',
    shapeRendering: 2, // geometricPrecision
  })
    .render()
    .asPng();

  await writeFile(path.join(OUT, `icon${size}.png`), png);
  console.log(`  icon${size}.png  ${String(png.length).padStart(5)} B   <- ${source}`);
}
console.log('\n  icons written to public/icons/\n');
