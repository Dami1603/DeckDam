// Sube o baja data/decks.json de Vercel Blob. Requiere BLOB_READ_WRITE_TOKEN.
//   node scripts/blob.mjs upload     -> sube data/decks.json (reemplaza el anterior)
//   node scripts/blob.mjs download   -> baja la versión publicada a data/decks.json (si no existe localmente)
import { head, put } from '@vercel/blob';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'decks.json');
const PATHNAME = process.env.DATA_BLOB_PATH ?? 'decks.json';

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('Falta BLOB_READ_WRITE_TOKEN');
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'upload') {
  const body = await readFile(FILE);
  JSON.parse(body.toString('utf8')); // no subir un archivo corrupto
  const res = await put(PATHNAME, body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60, // la CDN de Blob refresca en ~1 minuto
    multipart: true,
  });
  console.log(`✓ subido ${(body.length / 1e6).toFixed(1)} MB → ${res.url}`);
} else if (cmd === 'download') {
  if (existsSync(FILE)) {
    console.log('data/decks.json ya existe: no se descarga');
  } else {
    try {
      const { url } = await head(PATHNAME);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await mkdir(path.dirname(FILE), { recursive: true });
      await writeFile(FILE, Buffer.from(await r.arrayBuffer()));
      console.log(`✓ bajada la versión publicada desde ${url}`);
    } catch (e) {
      console.log(`Sin versión publicada todavía (${e.message}): se hace un scraping completo`);
    }
  }
} else {
  console.error('Uso: node scripts/blob.mjs upload|download');
  process.exit(1);
}
