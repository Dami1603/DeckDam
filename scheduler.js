// Automatic deck updates: while the server runs, it launches the scraper every N hours.
//   SCRAPE_INTERVAL_HOURS=12  (default)   ·   SCRAPE_INTERVAL_HOURS=0  disables it
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
    log('Automatic updates disabled (SCRAPE_INTERVAL_HOURS=0)');
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
    log('↻ Updating decks (automatic scraping)…');

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
        // a manual scrape was already running: retry in a while
        status.lastRun = { finishedAt: new Date().toISOString(), ok: false, message: 'Another scrape is running; retrying in 15 min', durationSec };
        schedule(15 * 60_000);
        return;
      }
      status.lastRun = { finishedAt: new Date().toISOString(), ok: code === 0, message: code === 0 ? lastLine : `Error (code ${code}): ${lastLine}`, durationSec };
      log(code === 0 ? `✓ Decks updated in ${durationSec}s` : `✗ Deck update failed (code ${code}); see data/scrape.log`);
      // on failure, retry sooner (1 h) instead of waiting the full interval
      schedule(code === 0 ? intervalHours * HOUR : Math.min(HOUR, intervalHours * HOUR));
    });
  }

  // on startup: if the data is older than the interval, update right away (after 10 s)
  lastUpdate().then((ts) => {
    const due = ts + intervalHours * HOUR - Date.now();
    schedule(Math.max(10_000, due));
    log(`Automatic updates every ${intervalHours} h · next: ${new Date(Date.now() + Math.max(10_000, due)).toLocaleString('en')}`);
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
