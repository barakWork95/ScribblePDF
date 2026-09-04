/**
 * Build script: esbuild bundles + static asset copy.
 * Deliberately dependency-light — no bundler plugins, no framework, so the
 * output stays auditable (Chrome Web Store review reads the shipped bundle).
 *
 *   node build.mjs            one-shot production build into dist/
 *   node build.mjs --watch    rebuild on change (load dist/ as an unpacked ext)
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
/** Build the web/PWA target into dist-web/ instead of the extension bundle. */
const web = process.argv.includes('--web');
const root = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(root, web ? 'dist-web' : 'dist');
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

/**
 * Web build assets. The shared viewer stylesheet is reused verbatim rather than
 * duplicated — only its relative asset paths need adjusting, since it moves
 * from viewer/ to the web root.
 */
const WEB_ASSETS = [
  ['public/web/index.html', 'index.html'],
  ['public/web/mobile.css', 'mobile.css'],
  ['public/web/manifest.webmanifest', 'manifest.webmanifest'],
  ['public/icons', 'icons'],
  [`${pdfjs}/build/pdf.worker.min.mjs`, 'vendor/pdf.worker.mjs'],
  [`${pdfjs}/cmaps`, 'vendor/cmaps'],
  [`${pdfjs}/standard_fonts`, 'vendor/standard_fonts'],
  ['public/fonts', 'vendor/fonts'],
];

async function copyWebAssets() {
  for (const [from, to] of WEB_ASSETS) {
    const src = path.isAbsolute(from) ? from : path.join(root, from);
    if (!existsSync(src)) {
      console.warn(`  ! missing asset, skipped: ${from}`);
      continue;
    }
    const dest = path.join(out, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true });
  }

  // viewer.css lives at viewer/ in the extension and at the root on the web, so
  // its @font-face URLs need one level removing.
  const css = await readFile(path.join(root, 'public/viewer/viewer.css'), 'utf8');
  await writeFile(path.join(out, 'app.css'), css.replaceAll('../vendor/', 'vendor/'), 'utf8');
}

/**
 * Emit the service worker with its precache list injected.
 *
 * Runs after bundling because the app chunks carry content hashes that do not
 * exist until esbuild has written them.
 */
async function writeServiceWorker() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  // The policy must exist before the precache list is hashed, so it is rendered
  // here rather than as a separate npm step that would run afterwards.
  execFileSync('node', [path.join(root, 'scripts/build-privacy.mjs'), out], {
    cwd: root,
    stdio: 'inherit',
  });

  // The policy is 6 KB and is linked from the store listing, so it is worth
  // having offline rather than 404-ing inside an installed PWA.
  const shell = [
    './',
    'index.html',
    'app.css',
    'mobile.css',
    'manifest.webmanifest',
    'privacy.html',
    'privacy/index.html',
  ];
  const emitted = (await readdir(out, { recursive: true })).map((f) => f.split(path.sep).join('/'));
  const bundled = emitted.filter((f) => /^(main\.js|chunk-.*\.js)$/.test(f));
  const assets = emitted.filter(
    (f) => f.startsWith('icons/') || f === 'vendor/pdf.worker.mjs' || f.startsWith('vendor/fonts/'),
  );

  const precache = [...shell, ...bundled, ...assets.filter((f) => !f.endsWith('OFL.txt'))].sort();

  // Cache name is versionplus a hash of the precached CONTENT, not the package
  // version alone. Tying it to the version means any change shipped without a
  // bump — a CSS tweak, a hotfix — leaves every existing install serving stale
  // assets out of its own cache, permanently. Hashing the bytes makes staleness
  // impossible to ship by accident.
  const digest = createHash('sha256');
  for (const file of precache) {
    if (file === './') continue;
    digest.update(file);
    digest.update(await readFile(path.join(out, file)));
  }
  const cacheVersion = `${pkg.version}-${digest.digest('hex').slice(0, 8)}`;

  const sw = (await readFile(path.join(root, 'public/web/sw.js'), 'utf8'))
    .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2))
    .replaceAll('__CACHE_VERSION__', cacheVersion);

  // A missed substitution produces a service worker that throws on load and
  // silently leaves the app with no offline support, so fail the build loudly.
  const leftover = sw.match(/__[A-Z_]+__/);
  if (leftover) throw new Error(`service worker placeholder not substituted: ${leftover[0]}`);

  await writeFile(path.join(out, 'sw.js'), sw, 'utf8');
  console.log(`  service worker: ${precache.length} precached entries, cache scribblepdf-${cacheVersion}`);
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

const targets = web
  ? [
      {
        entryPoints: { main: 'src/web/main.ts' },
        splitting: true,
        chunkNames: 'chunk-[name]-[hash]',
      },
    ]
  : [
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

if (web) await copyWebAssets();
else await copyAssets();

if (dev && !web) await writeHarness();

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context({ ...shared, ...t, outdir: out });
    await ctx.watch();
  }
  console.log('\n  watching… load dist/ via chrome://extensions → Load unpacked\n');
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...shared, ...t, outdir: out })));
  if (web) await writeServiceWorker();
  console.log(`\n  built → ${path.basename(out)}/\n`);
}
