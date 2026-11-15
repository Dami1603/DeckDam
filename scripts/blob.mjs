// Uploads or downloads data/decks.json from Vercel Blob. Requires BLOB_READ_WRITE_TOKEN.
//   node scripts/blob.mjs upload     -> uploads data/decks.json (replaces the previous one)
//   node scripts/blob.mjs download   -> downloads the published version to data/decks.json (if it does not exist locally)
import { head, put } from '@vercel/blob';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'decks.json');
const PATHNAME = process.env.DATA_BLOB_PATH ?? 'decks.json';

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('Missing BLOB_READ_WRITE_TOKEN');
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'upload') {
  const body = await readFile(FILE);
  JSON.parse(body.toString('utf8')); // never upload a corrupt file
  const res = await put(PATHNAME, body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60, // the Blob CDN refreshes in ~1 minute
    multipart: true,
  });
  console.log(`✓ uploaded ${(body.length / 1e6).toFixed(1)} MB → ${res.url}`);
} else if (cmd === 'download') {
  if (existsSync(FILE)) {
    console.log('data/decks.json already exists: not downloading');
  } else {
    try {
      const { url } = await head(PATHNAME);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await mkdir(path.dirname(FILE), { recursive: true });
      await writeFile(FILE, Buffer.from(await r.arrayBuffer()));
      console.log(`✓ downloaded the published version from ${url}`);
    } catch (e) {
      console.log(`No published version yet (${e.message}): doing a full scrape`);
    }
  }
} else {
  console.error('Usage: node scripts/blob.mjs upload|download');
  process.exit(1);
}
