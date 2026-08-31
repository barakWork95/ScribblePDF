/**
 * Build a Chrome Web Store submission zip.
 *
 *   npm run package        -> releases/scribblepdf-<version>.zip
 *
 * This is the last gate before an upload, so it does not just zip a folder: it
 * re-builds from clean and then *refuses* to package anything that looks like a
 * development artefact. A dev hook or a stray source map reaching the store is
 * the kind of mistake that is only caught in review, days later.
 */
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname) + '/..';
const dist = path.join(root, 'dist');
const releases = path.join(root, 'releases');

const problems = [];
const fail = (msg) => problems.push(msg);

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
}

/** Every file in dist/, as paths relative to dist/. */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

console.log('\n  cleaning and building…\n');
await rm(dist, { recursive: true, force: true });
run('node', [path.join(root, 'build.mjs')]);

const files = await walk(dist);
const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// --- gate 1: no development artefacts -------------------------------------
const FORBIDDEN = [
  { test: (f) => f.startsWith('dev/'), why: 'dev harness directory' },
  { test: (f) => f.startsWith('assets/'), why: 'icon design sources' },
  { test: (f) => f.endsWith('.map'), why: 'source map' },
  { test: (f) => f.endsWith('harness.html'), why: 'dev harness page' },
  { test: (f) => f.endsWith('.ts'), why: 'TypeScript source' },
];
for (const f of files) {
  for (const rule of FORBIDDEN) {
    if (rule.test(f)) fail(`dist contains a ${rule.why}: ${f}`);
  }
}

// --- gate 2: no dev hooks survived tree shaking ---------------------------
for (const f of files.filter((f) => f.endsWith('.js'))) {
  const body = await readFile(path.join(dist, f), 'utf8');
  for (const token of ['__paDev', '__paHarness', 'exportAndReload']) {
    if (body.includes(token)) fail(`dev hook "${token}" survived into ${f}`);
  }
  if (body.includes('sourceMappingURL')) fail(`source map reference in ${f}`);
}

// --- gate 3: manifest sanity ---------------------------------------------
if (manifest.version !== pkg.version) {
  fail(`manifest version ${manifest.version} != package.json ${pkg.version}`);
}
// file:///* is the one allowed declaration: file access cannot be requested at
// runtime, it is governed by a toggle that defaults to off, and declaring the
// pattern is the only way to make that toggle available. Anything else here
// would mean site access at install, which is what the optional model avoids.
const ALLOWED_HOST_PERMISSIONS = ['file:///*'];
for (const pattern of manifest.host_permissions ?? []) {
  if (!ALLOWED_HOST_PERMISSIONS.includes(pattern)) {
    fail(`manifest declares host_permission "${pattern}"; only ${ALLOWED_HOST_PERMISSIONS.join(', ')} is allowed`);
  }
}
if (!manifest.icons) fail('manifest has no icons');
for (const [size, rel] of Object.entries(manifest.icons ?? {})) {
  const icon = path.join(dist, rel);
  if (!existsSync(icon)) fail(`icon ${size} missing: ${rel}`);
  else if ((await stat(icon)).size === 0) fail(`icon ${size} is empty: ${rel}`);
}
if (!/^\d+\.\d+(\.\d+)?(\.\d+)?$/.test(manifest.version)) {
  fail(`version "${manifest.version}" is not a valid Chrome extension version`);
}
if ((manifest.description ?? '').length > 132) {
  fail(`description is ${manifest.description.length} chars; the store limit is 132`);
}

if (problems.length > 0) {
  console.error('\n  PACKAGE REFUSED\n');
  for (const p of problems) console.error(`    - ${p}`);
  console.error('');
  process.exit(1);
}

// --- zip ------------------------------------------------------------------
// The store requires manifest.json at the archive root, so we zip the contents
// of dist/ rather than dist/ itself.
await mkdir(releases, { recursive: true });
const zipName = `scribblepdf-${manifest.version}.zip`;
const zipPath = path.join(releases, zipName);
await rm(zipPath, { force: true });

try {
  execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: dist, stdio: 'inherit' });
} catch (err) {
  console.error(
    '\n  Could not run `zip`. It ships with macOS and most Linux distros;\n' +
      '  on Windows use WSL or Git Bash, or zip the contents of dist/ by hand\n' +
      '  (manifest.json must sit at the archive root).\n',
  );
  throw err;
}

const { size } = await stat(zipPath);
console.log(`\n  ${files.length} files, ${(size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  → releases/${zipName}\n`);
if (manifest.version.startsWith('0.')) {
  console.log('  note: version is still 0.x — bump to 1.0.0 before a public listing.\n');
}
