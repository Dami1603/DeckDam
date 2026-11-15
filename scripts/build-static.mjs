// Build de Vercel: copia public/ a dist/ (servido como estático por la CDN) y completa %SITE_URL% en index.html.
// SITE_URL (opcional) o, si no está, el dominio de producción del proyecto en Vercel.
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'dist');

if (!existsSync(path.join(SRC, 'index.html'))) {
  console.error('Falta public/index.html: publica desde tu PC con la CLI de Vercel (el frontend no está en GitHub).');
  process.exit(1);
}

const siteUrl = (
  process.env.SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '') ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
).replace(/\/+$/, '');

await rm(OUT, { recursive: true, force: true });
await cp(SRC, OUT, { recursive: true, filter: (src) => path.basename(src) !== 'README.md' });
const html = await readFile(path.join(OUT, 'index.html'), 'utf8');
await writeFile(path.join(OUT, 'index.html'), html.replaceAll('%SITE_URL%', siteUrl), 'utf8');
console.log(`dist/ listo (SITE_URL = ${siteUrl || '(relativo)'})`);
