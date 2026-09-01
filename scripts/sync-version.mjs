/**
 * Copy package.json's version into the source manifest.json.
 *
 * build.mjs already rewrites the version in dist/, so a stale source manifest
 * never breaks a build — which is exactly why it drifted unnoticed (package
 * said 1.0.1 while the checked-in manifest still said 1.0.0). Wiring this to
 * npm's `version` lifecycle keeps the two honest at the moment of the bump.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname) + '/..';
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.version === pkg.version) {
  console.log(`  manifest.json already at ${pkg.version}`);
} else {
  const previous = manifest.version;
  manifest.version = pkg.version;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`  manifest.json ${previous} → ${pkg.version}`);
}
