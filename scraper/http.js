// Cliente HTTP con caché en disco y límite de velocidad por host,
// para no castigar a las páginas de origen.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = process.env.VERCEL ? path.join(os.tmpdir(), 'deckdam-cache') : path.join(ROOT, 'data', 'cache');
const UA = 'Mozilla/5.0 (compatible; DeckDam/0.1; deck research)';
const MIN_INTERVAL_MS = Number(process.env.SCRAPE_DELAY_MS ?? 400);

const hostQueues = new Map();

function schedule(host, task) {
  const prev = hostQueues.get(host) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      return await task();
    } finally {
      await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
    }
  });
  hostQueues.set(host, next.catch(() => {}));
  return next;
}

/**
 * GET de texto con caché.
 * @param {string} url
 * @param {{ttlHours?: number, retries?: number}} opts ttlHours=Infinity para páginas inmutables
 */
export async function getText(url, { ttlHours = 12, retries = 2 } = {}) {
  await mkdir(CACHE_DIR, { recursive: true });
  const key = createHash('sha1').update(url).digest('hex');
  const file = path.join(CACHE_DIR, key + '.html');

  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs < ttlHours * 3600_000) return await readFile(file, 'utf8');
  } catch {}

  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    try {
      const text = await schedule(host, async () => {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'en,ja;q=0.8' },
          redirect: 'follow',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        return res.text();
      });
      await writeFile(file, text, 'utf8');
      return text;
    } catch (err) {
      if (attempt >= retries || /HTTP 404/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

/** Ejecuta fn sobre items con concurrencia limitada. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
