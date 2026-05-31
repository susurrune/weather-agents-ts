// Copy non-TS runtime assets into dist/ (tsc only emits .js/.d.ts).
// The voice client HTML is served verbatim by the voice server.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = [['src/web/voice.html', 'dist/web/voice.html']];

for (const [from, to] of assets) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) {
    console.error(`copy-assets: missing ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`copy-assets: ${from} -> ${to}`);
}
