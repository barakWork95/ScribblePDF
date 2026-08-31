/**
 * Build script: esbuild bundles + static asset copy.
 * Deliberately dependency-light — no bundler plugins, no framework, so the
 * output stays auditable (Chrome Web Store review reads the shipped bundle).
 *
 *   node build.mjs            one-shot production build into dist/
 *   node build.mjs --watch    rebuild on change (load dist/ as an unpacked ext)
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const root = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(root, 'dist');
const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist');

/** Static files copied verbatim into dist/. */
const ASSETS = [
  ['manifest.json', 'manifest.json'],
  ['public/viewer', 'viewer'],
  ['public/icons', 'icons'],
  // Bundled so the exporter can embed real Hebrew glyphs (OFL, see fonts/OFL.txt).
  ['public/fonts', 'vendor/fonts'],
  [`${pdfjs}/build/pdf.worker.min.mjs`, 'vendor/pdf.worker.mjs'],
  [`${pdfjs}/cmaps`, 'vendor/cmaps'],
  [`${pdfjs}/standard_fonts`, 'vendor/standard_fonts'],
];

/** Dev-only: sample document plus the chrome.* shim for the browser harness. */
const DEV_ASSETS = [
  ['dev', 'dev'],
  // Icon design sources, for the icon preview/rasteriser page. Never shipped.
  ['assets', 'assets'],
];

/**
 * Generate the dev harness from the real viewer.html rather than keeping a
 * second copy of the markup. The harness used to be a hand-maintained
 * duplicate, which silently went stale every time the viewer gained an element.
 */
async function writeHarness() {
  const html = await readFile(path.join(root, 'public/viewer/viewer.html'), 'utf8');
  const harness = html
    .replace('<title>', '<title>[harness] ')
    .replace('<body>', '<body>\n    <script src="../dev/shim.js"></script>');
  await writeFile(path.join(out, 'viewer/harness.html'), harness, 'utf8');
}

async function copyAssets() {
  for (const [from, to] of [...ASSETS, ...(dev ? DEV_ASSETS : [])]) {
    const src = path.isAbsolute(from) ? from : path.join(root, from);
    if (!existsSync(src)) {
      console.warn(`  ! missing asset, skipped: ${from}`);
      continue;
    }
    const dest = path.join(out, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true });
  }
  // Keep the shipped manifest version in sync with package.json.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = pkg.version;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'esm',
  target: ['chrome116'],
  platform: 'browser',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
  define: { __DEV__: String(dev) },
  alias: { '@': path.join(root, 'src') },
};

const targets = [
  { entryPoints: { 'background/service-worker': 'src/background/service-worker.ts' } },
  {
    entryPoints: { 'viewer/main': 'src/viewer/main.ts' },
    // Splitting lets the dynamically imported exporter (pdf-lib + fontkit +
    // bidi-js) land in its own chunk instead of blocking first render.
    splitting: true,
    chunkNames: 'viewer/chunk-[name]-[hash]',
  },
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyAssets();

if (dev) await writeHarness();

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context({ ...shared, ...t, outdir: out });
    await ctx.watch();
  }
  console.log('\n  watching… load dist/ via chrome://extensions → Load unpacked\n');
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...shared, ...t, outdir: out })));
  console.log('\n  built → dist/\n');
}
