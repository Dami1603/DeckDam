// Actualización automática de mazos: mientras el servidor corre, lanza el scraper cada N horas.
//   SCRAPE_INTERVAL_HOURS=12  (por defecto)   ·   SCRAPE_INTERVAL_HOURS=0  lo desactiva
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3600_000;

export function startScheduler({ root, dataFile, log = console.log }) {
  const intervalHours = Number(process.env.SCRAPE_INTERVAL_HOURS ?? 12);
  const status = {
    enabled: intervalHours > 0,
    intervalHours,
    running: false,
    startedAt: null,
    lastRun: null, // { finishedAt, ok, message, durationSec }
    nextRun: null,
  };
  if (!status.enabled) {
    log('Actualización automática desactivada (SCRAPE_INTERVAL_HOURS=0)');
    return status;
  }

  let timer = null;
  let child = null;

  const schedule = (delayMs) => {
    clearTimeout(timer);
    status.nextRun = new Date(Date.now() + delayMs).toISOString();
    timer = setTimeout(run, delayMs);
    timer.unref?.();
  };

  async function lastUpdate() {
    try {
      const raw = JSON.parse(await readFile(dataFile, 'utf8'));
      if (raw.updatedAt) return new Date(raw.updatedAt).getTime();
    } catch {}
    try {
      return (await stat(dataFile)).mtimeMs;
    } catch {
      return 0;
    }
  }

  function run() {
    if (status.running) return;
    status.running = true;
    status.startedAt = new Date().toISOString();
    status.nextRun = null;
    const t0 = Date.now();
    log('↻ Actualizando mazos (scraping automático)…');

    const out = createWriteStream(path.join(root, 'data', 'scrape.log'));
    child = spawn(process.execPath, [path.join(root, 'scraper', 'index.js')], { cwd: root, env: process.env });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    let tail = '';
    const keep = (buf) => (tail = (tail + buf.toString()).slice(-600));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    child.on('close', (code) => {
      child = null;
      status.running = false;
      const durationSec = Math.round((Date.now() - t0) / 1000);
      const lastLine = tail.trim().split('\n').filter(Boolean).at(-1) ?? '';
      if (code === 2) {
        // ya había un scraping manual en curso: reintentar en un rato
        status.lastRun = { finishedAt: new Date().toISOString(), ok: false, message: 'Otro scraping en curso; se reintenta en 15 min', durationSec };
        schedule(15 * 60_000);
        return;
      }
      status.lastRun = { finishedAt: new Date().toISOString(), ok: code === 0, message: code === 0 ? lastLine : `Error (código ${code}): ${lastLine}`, durationSec };
      log(code === 0 ? `✓ Mazos actualizados en ${durationSec}s` : `✗ Falló la actualización de mazos (código ${code}); ver data/scrape.log`);
      // si falló, reintentar antes (1 h) en vez de esperar el intervalo completo
      schedule(code === 0 ? intervalHours * HOUR : Math.min(HOUR, intervalHours * HOUR));
    });
  }

  // al arrancar: si los datos son más viejos que el intervalo, actualizar enseguida (tras 10 s)
  lastUpdate().then((ts) => {
    const due = ts + intervalHours * HOUR - Date.now();
    schedule(Math.max(10_000, due));
    log(`Actualización automática cada ${intervalHours} h · próxima: ${new Date(Date.now() + Math.max(10_000, due)).toLocaleString('es')}`);
  });

  const stop = () => child?.kill();
  process.on('exit', stop);
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });

  status.runNow = run;
  return status;
}
