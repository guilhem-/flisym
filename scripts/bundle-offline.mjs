#!/usr/bin/env node
// Build a single self-contained HTML file from dist/ by inlining the module bundle.
// Output: docs/play.html — playable from file:// or any static host, no network needed.
//
// Run via `npm run build:offline` (which runs `npm run build` first).

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(repoRoot, 'dist', 'index.html');
const outPath = join(repoRoot, 'docs', 'play.html');

let html;
try {
  html = readFileSync(distIndex, 'utf8');
} catch {
  throw new Error(`dist/index.html missing — run 'npm run build' first.`);
}

const scriptRegex = /<script\s+type="module"[^>]*\ssrc="([^"]+)"[^>]*><\/script>/;
const match = html.match(scriptRegex);
if (!match) throw new Error('Could not locate <script type="module" src="..."> in dist/index.html');

const scriptHref = match[1].replace(/^\//, '');
const scriptPath = join(repoRoot, 'dist', scriptHref);
const scriptBody = readFileSync(scriptPath, 'utf8')
  .replace(/\/\/#\s*sourceMappingURL=.*$/m, '')
  .replace(/<\/script>/gi, '<\\/script>');

const inlined =
  `<script type="module">\n/* inlined from ${scriptHref} */\n${scriptBody}\n</script>`;

const bannerComment =
  '<!--\n  FLISYM — offline playable build.\n' +
  '  Double-click to open in a browser, or host the file anywhere static.\n' +
  '  Regenerate with: npm run build:offline\n-->\n';

// Pass a replacer FUNCTION (not a string) so that `$&`, `$1`, etc. that appear
// inside the minified bundle aren't interpreted as backreferences and substituted
// with the matched <script src="..."> tag.
const out = bannerComment + html.replace(scriptRegex, () => inlined);
writeFileSync(outPath, out, 'utf8');

const { size } = statSync(outPath);
console.log(`wrote ${outPath} (${(size / 1024).toFixed(1)} KB)`);
