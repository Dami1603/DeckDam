// DeckDam — card scanner: reads a physical card with the rear camera and finds it in TCGdex.
//
// Everything runs on the device: the frames are read with Tesseract (OCR) and never leave the phone.
// A card is identified by its collector number ("045/198"), which narrows it down to a few prints,
// and confirmed with the set code ("SVI") and the name printed at the top of the card.
import { normName } from './cardkey.js';
import { t, getLang } from './i18n.js';

const TCGDEX = 'https://api.tcgdex.net/v2';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js';

// Areas of the card that are read, as fractions of the card frame
const REGIONS = {
  foot: { x: 0.02, y: 0.885, w: 0.96, h: 0.105, width: 1500 },
  footLeft: { x: 0.02, y: 0.895, w: 0.53, h: 0.095, width: 1500 }, // the number is usually here: closer look
  head: { x: 0.03, y: 0.02, w: 0.8, h: 0.13, width: 1100 },
};
const FOOT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/';
const NAME_MIN_SCORE = 0.72; // similarity between the printed name and the catalogue name to trust it
const NAME_ONLY_SCORE = 0.85; // stricter: the name is the only clue when the number could not be read
const HEAD_NOISE = new Set(['basic', 'stage', 'evolves', 'from', 'trainer', 'item', 'supporter', 'stadium', 'tool', 'pokemon', 'energy', 'special', 'mega']);
const CONFIRM_AFTER = 3; // frames with the same unconfirmed reading before asking the user
const WORKER_IDLE_MS = 60_000; // the OCR engine stays loaded for a while to scan several cards in a row

// Printed without a total: "SVP 045"
const PROMO_SETS = { SVP: 'svp', MEP: 'mep' };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------- OCR engine
let workerPromise = null;
let workerTimer = null;

/** Loads the OCR engine once (a few MB the first time, then cached by the browser). */
export function loadOcr() {
  clearTimeout(workerTimer);
  workerPromise ??= (async () => {
    const { createWorker } = (await import(TESSERACT_URL)).default;
    return createWorker('eng', 1);
  })();
  workerPromise.catch(() => (workerPromise = null));
  return workerPromise;
}

function releaseOcrLater() {
  clearTimeout(workerTimer);
  workerTimer = setTimeout(async () => {
    const pending = workerPromise;
    workerPromise = null;
    (await pending?.catch(() => null))?.terminate();
  }, WORKER_IDLE_MS);
}

/** Crops an area of the card and stretches its contrast so small print stands out. */
export function prepareRegion(source, box, region) {
  const sx = box.x + region.x * box.w;
  const sy = box.y + region.y * box.h;
  const sw = region.w * box.w;
  const sh = region.h * box.h;
  const canvas = document.createElement('canvas');
  canvas.width = region.width;
  canvas.height = Math.round((sh / sw) * region.width);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) hist[Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])]++;
  const total = px.length / 4;
  let lo = 0;
  let hi = 255;
  for (let n = 0; lo < 255 && (n += hist[lo]) < total * 0.02; ) lo++;
  for (let n = 0; hi > 0 && (n += hist[hi]) < total * 0.02; ) hi--;
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    const gray = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, ((gray - lo) / range) * 255));
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** OCR of the bottom line and the name of the card inside `box`. Consecutive passes crop the bottom line differently. */
export async function readFrame(worker, source, box, pass = 0) {
  await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: FOOT_CHARS });
  const foot = await worker.recognize(prepareRegion(source, box, pass % 2 ? REGIONS.footLeft : REGIONS.foot));
  await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
  const head = await worker.recognize(prepareRegion(source, box, REGIONS.head));
  return { foot: foot.data.text, head: head.data.text };
}

// ---------------------------------------------------------------- reading the printed text
const DIGIT_FIXES = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8' };
const fixDigits = (s) => s.replace(/[OQDILZSB]/g, (c) => DIGIT_FIXES[c]);

/** Splits "TG12" into prefix + number, and drops a set code stuck to the number ("SVI045" -> "045"). */
function splitNumber(token) {
  const special = token.match(/^(TG|GG|SV|RC)([0-9OQDILZSB]{1,3})$/);
  if (special) return { prefix: special[1], digits: fixDigits(special[2]) };
  const tail = fixDigits(token).match(/(\d{1,3})$/);
  return tail ? { prefix: '', digits: tail[1] } : null;
}

/** Collector numbers and set codes found in the bottom line of a card. */
export function parseFoot(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[|\\]/g, '/');
  const numbers = [];
  const add = (n) => {
    if (!numbers.some((o) => o.number === n.number && o.total === n.total && o.promo === n.promo)) numbers.push(n);
  };
  for (const m of clean.matchAll(/([A-Z0-9]{1,8})\s*\/\s*([A-Z0-9]{2,6})/g)) {
    const left = splitNumber(m[1]);
    const special = m[2].match(/^(TG|GG|SV|RC)([0-9OQDILZSB]{2,3})/);
    // the total is read from its start: noise can follow it ("167/1674")
    const total = special ? special[1] + fixDigits(special[2]) : fixDigits(m[2]).match(/^\d{2,3}/)?.[0];
    if (!left || !total) continue;
    add({ number: left.prefix + left.digits, total, digits: Number(left.digits), prefix: left.prefix });
  }
  // the slash read as another character: 0451198 or 0457198 -> 045/198
  for (const m of clean.matchAll(/(\d{3})[17IL](\d{3})/g)) add({ number: m[1], total: m[2], digits: Number(m[1]), prefix: '' });
  for (const m of clean.matchAll(/\b(SVP|MEP)\b(?:\s+[A-Z]{2})?\s*([0-9OQDILZSB]{1,3})\b/g)) {
    const digits = fixDigits(m[2]);
    add({ number: digits, total: null, digits: Number(digits), prefix: '', promo: PROMO_SETS[m[1]] });
  }
  const codes = [...new Set(clean.match(/\b[A-Z][A-Z0-9]{2}\b/g) ?? [])];
  // totals are kept apart: they still help when the number before the slash is unreadable
  const totals = [...new Set([...clean.matchAll(/\/\s*([0-9OQDILZSB]{3})/g)].map((m) => Number(fixDigits(m[1]))))];
  return { numbers, codes, totals };
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

const squash = (s) => normName(s).replace(/[^a-z0-9]/g, '');

/** 0..1: how well a catalogue name appears inside the text read at the top of the card. */
export function nameScore(name, text) {
  const wanted = squash(name);
  const read = squash(text);
  if (!wanted || !read) return 0;
  if (read.includes(wanted)) return 1;
  let best = Infinity;
  for (const len of [wanted.length - 1, wanted.length, wanted.length + 1]) {
    for (let i = 0; i + len <= read.length; i++) best = Math.min(best, editDistance(wanted, read.slice(i, i + len)));
  }
  if (best === Infinity) best = editDistance(wanted, read);
  return Math.max(0, 1 - best / wanted.length);
}

// ---------------------------------------------------------------- catalogue lookup
const memo = new Map();
function getJSON(url) {
  if (!memo.has(url)) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => memo.delete(url));
    memo.set(url, p);
  }
  return memo.get(url);
}

/** Sets by id, with printed totals; TCG Pocket is left out because it has no physical cards. */
async function physicalSets() {
  const [sets, pocket] = await Promise.all([getJSON(`${TCGDEX}/en/sets`), getJSON(`${TCGDEX}/en/series/tcgp`).catch(() => ({ sets: [] }))]);
  const skip = new Set((pocket.sets ?? []).map((s) => s.id));
  return new Map(sets.filter((s) => !skip.has(s.id)).map((s) => [s.id, s]));
}

const setDetail = (lang, setId) => getJSON(`${TCGDEX}/${lang}/sets/${encodeURIComponent(setId)}`);

/** Sets a reading can belong to: by printed total, by promo code, or by special numbering ("TG12"). */
async function targetSets(reading, sets) {
  if (reading.promo) return sets.has(reading.promo) ? [reading.promo] : [];
  if (reading.prefix) {
    const list = await getJSON(`${TCGDEX}/en/cards?localId=${encodeURIComponent(`eq:${reading.number}`)}`);
    return [...new Set(list.map((c) => c.id.slice(0, c.id.lastIndexOf('-'))))].filter((id) => sets.has(id));
  }
  return [...sets.values()].filter((s) => s.cardCount?.official === Number(reading.total)).map((s) => s.id);
}

/** Prints with this collector number, with their English and Spanish names. */
async function printsWith(reading, sets) {
  const same = (localId) => (reading.prefix ? localId === reading.number : /^\d+$/.test(localId) && Number(localId) === reading.digits);
  const ids = await targetSets(reading, sets);
  const rows = await Promise.all(
    ids.slice(0, 6).map(async (setId) => {
      const [en, es] = await Promise.all([setDetail('en', setId), setDetail('es', setId).catch(() => null)]);
      const enCard = en.cards?.find((c) => same(String(c.localId)));
      const esCard = es?.cards?.find((c) => same(String(c.localId)));
      const card = enCard ?? esCard;
      if (!card) return null;
      return {
        id: card.id,
        localId: card.localId,
        setId,
        setName: en.name,
        code: en.abbreviation?.official ?? null,
        image: enCard?.image ?? esCard?.image ?? null,
        name: card.name,
        names: [enCard?.name, esCard?.name].filter(Boolean),
        langs: [enCard && 'en', esCard && 'es'].filter(Boolean),
      };
    }),
  );
  return rows.filter(Boolean);
}

/** Text above "Evolves from X": otherwise the name of the previous evolution would be taken for the card's. */
const cardTitle = (text) => String(text ?? '').split(/e?volves|evoluciona|\bfrom\b/i)[0];

const headWords = (text) => [...new Set(normName(text).match(/[a-z]{4,}/g) ?? [])].filter((w) => !HEAD_NOISE.has(w));

/**
 * Second chance when the number is unreadable: searches the name printed at the top of the card.
 * Only words read the same on two frames in a row are searched, so OCR noise causes no requests.
 */
async function findByName(head, previousHead, { numbers, codes, totals }, sets) {
  const previous = new Set(headWords(previousHead));
  const words = headWords(head)
    .filter((w) => previous.has(w))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  if (!words.length) return null;

  const lists = await Promise.all(
    words.flatMap((w) =>
      ['en', 'es'].map((lang) =>
        getJSON(`${TCGDEX}/${lang}/cards?name=${encodeURIComponent(w)}`)
          .then((list) => list.map((c) => ({ ...c, lang })))
          .catch(() => []),
      ),
    ),
  );
  const order = [...sets.keys()];
  const byId = new Map();
  for (const c of lists.flat()) {
    const setId = c.id.slice(0, c.id.lastIndexOf('-'));
    const score = nameScore(c.name, head);
    if (!sets.has(setId) || score < NAME_ONLY_SCORE) continue;
    const row = byId.get(c.id) ?? { id: c.id, localId: c.localId, setId, setName: sets.get(setId).name, image: null, name: c.name, names: [], langs: [], score: 0 };
    row.names.push(c.name);
    if (!row.langs.includes(c.lang)) row.langs.push(c.lang);
    row.image ??= c.image ?? null;
    if (c.lang === 'en') row.name = c.name;
    row.score = Math.max(row.score, score);
    byId.set(c.id, row);
  }
  const rows = [...byId.values()];
  if (!rows.length) return null;

  const sameTotal = rows.filter((c) => totals.includes(sets.get(c.setId).cardCount?.official));
  const newest = [...rows].sort((a, b) => order.indexOf(b.setId) - order.indexOf(a.setId));
  const shortlist = sameTotal.length ? sameTotal : newest.slice(0, 6);
  const details = await Promise.all(shortlist.map((c) => setDetail('en', c.setId).catch(() => null)));
  const close = (c) => numbers.some((n) => editDistance(String(n.digits), String(Number(c.localId))) <= 1);
  const ranked = shortlist
    .map((c, i) => ({ ...c, setName: details[i]?.name ?? c.setName, codeOk: codes.includes(details[i]?.abbreviation?.official), close: close(c) }))
    .sort((a, b) => Number(b.close) + Number(b.codeOk) - (Number(a.close) + Number(a.codeOk)) || b.score - a.score || squash(b.name).length - squash(a.name).length);

  if (sameTotal.length) {
    const near = ranked.filter((c) => c.close);
    if (ranked.length === 1 || near.length === 1) return { status: 'match', card: near[0] ?? ranked[0] };
  }
  const coded = ranked.filter((c) => c.codeOk);
  if (coded.length === 1) return { status: 'match', card: coded[0] };
  return { status: 'maybe', cards: ranked.slice(0, 6), read: ranked[0].name };
}

/**
 * Looks up what was read on a frame.
 * @param {{foot:string, head:string}} reading
 * @param {string} [previousHead] name area read on the previous frame
 * @returns {Promise<{status:'match', card:object}|{status:'maybe', cards:object[], read:string}|{status:'none', read:string|null}>}
 */
export async function findCard({ foot, head: rawHead }, rawPreviousHead = '') {
  const head = cardTitle(rawHead);
  const previousHead = cardTitle(rawPreviousHead);
  const parsed = parseFoot(foot);
  const { numbers, codes } = parsed;
  const read = numbers.length ? (numbers[0].total ? `${numbers[0].number}/${numbers[0].total}` : numbers[0].number) : null;
  const sets = await physicalSets();
  const rows = [];
  for (const reading of numbers.slice(0, 3)) rows.push(...(await printsWith(reading, sets)));

  let maybe = null;
  if (rows.length) {
    const scored = rows
      .map((c) => ({ ...c, score: Math.max(...c.names.map((n) => nameScore(n, head))), codeOk: codes.includes(c.code) }))
      .sort((a, b) => Number(b.codeOk) + b.score - (Number(a.codeOk) + a.score));
    const best = scored[0];
    const named = scored.filter((c) => c.score >= NAME_MIN_SCORE);
    if (best.score >= NAME_MIN_SCORE && (best.codeOk || named.length === 1)) return { status: 'match', card: best };
    if (best.codeOk && scored.filter((c) => c.codeOk).length === 1) return { status: 'match', card: best };
    maybe = { status: 'maybe', cards: scored.slice(0, 4), read };
  }
  const byName = await findByName(head, previousHead, parsed, sets);
  if (byName?.status === 'match') return byName;
  return maybe ?? byName ?? { status: 'none', read };
}

// ---------------------------------------------------------------- camera screen
const ICONS = {
  close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  torch: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 5 14h6l-1 8 8-12h-6z"/></svg>',
};

/** Part of the video (in video pixels) that is under the on-screen card frame. */
function frameBox(video, guide) {
  const v = video.getBoundingClientRect();
  const g = guide.getBoundingClientRect();
  const scale = Math.max(v.width / video.videoWidth, v.height / video.videoHeight);
  const offsetX = (v.width - video.videoWidth * scale) / 2;
  const offsetY = (v.height - video.videoHeight * scale) / 2;
  return { x: (g.left - v.left - offsetX) / scale, y: (g.top - v.top - offsetY) / scale, w: g.width / scale, h: g.height / scale };
}

function cameraError(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return 'scan.denied';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'scan.noCamera';
  if (e?.name === 'NotReadableError' || e?.name === 'AbortError') return 'scan.busy';
  return 'scan.unsupported';
}

/**
 * Opens the scanner inside `root`.
 * @param {{root:HTMLElement, onCard:(id:string, lang:string)=>void, onClose:()=>void, onSearch:()=>void}} options
 * @returns {() => void} stops the camera and the reading loop
 */
export function startScanner({ root, onCard, onClose, onSearch }) {
  root.innerHTML = `
    <section class="scan" aria-label="${esc(t('scan.title'))}">
      <video class="scan-video" playsinline muted autoplay></video>
      <div class="scan-guide" aria-hidden="true"><i></i><i></i><i></i><i></i><span class="scan-beam"></span></div>
      <header class="scan-top">
        <button type="button" class="scan-btn" data-act="close" aria-label="${esc(t('scan.close'))}">${ICONS.close}</button>
        <h1>${esc(t('scan.title'))}</h1>
        <button type="button" class="scan-btn" data-act="torch" aria-label="${esc(t('scan.torch'))}" aria-pressed="false" hidden>${ICONS.torch}</button>
      </header>
      <footer class="scan-bottom">
        <p class="scan-hint" role="status" aria-live="polite"></p>
        <button type="button" class="scan-link" data-act="search">${esc(t('scan.byName'))}</button>
      </footer>
      <div class="scan-sheet" hidden></div>
    </section>`;

  const el = root.querySelector('.scan');
  const video = el.querySelector('video');
  const guide = el.querySelector('.scan-guide');
  const hint = el.querySelector('.scan-hint');
  const sheet = el.querySelector('.scan-sheet');
  const torchBtn = el.querySelector('[data-act="torch"]');

  let stopped = false;
  let stream = null;
  let paused = false; // waiting for the user to answer the confirmation sheet
  let loopRunning = false;
  const seen = new Map(); // unconfirmed reading -> frames in a row
  const rejected = new Set(); // prints the user said are not the card
  let frames = 0;
  let previousHead = '';

  document.documentElement.classList.add('scan-open');

  const setHint = (msg) => {
    if (hint.textContent !== msg) hint.textContent = msg;
  };

  function stopCamera() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    torchBtn.hidden = true;
    torchBtn.setAttribute('aria-pressed', 'false');
  }

  function showError(key) {
    stopCamera();
    el.classList.add('is-error');
    sheet.hidden = false;
    sheet.innerHTML = `
      <h2>${esc(t('scan.errorTitle'))}</h2>
      <p>${esc(t(key))}</p>
      <div class="scan-sheet-actions">
        <button type="button" class="btn primary" data-act="retry">${esc(t('scan.retry'))}</button>
        <button type="button" class="btn" data-act="search">${esc(t('scan.byName'))}</button>
      </div>`;
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return showError('scan.unsupported');
    setHint(t('scan.starting'));
    let media;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      });
    } catch (e) {
      if (!stopped) showError(cameraError(e));
      return;
    }
    if (stopped || document.hidden) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = media;
    video.srcObject = media;
    await video.play().catch(() => {});

    const track = media.getVideoTracks()[0];
    const caps = track.getCapabilities?.() ?? {};
    if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    torchBtn.hidden = !caps.torch;
    readLoop();
  }

  function showCandidates(cards) {
    paused = true;
    sheet.hidden = false;
    sheet.innerHTML = `
      <h2>${esc(t(cards.length > 1 ? 'scan.whichOne' : 'scan.isThis'))}</h2>
      <div class="scan-options">
        ${cards
          .map(
            (c) => `
          <button type="button" class="scan-option" data-id="${esc(c.id)}">
            ${c.image ? `<img src="${esc(c.image)}/low.webp" alt="" referrerpolicy="no-referrer">` : '<span class="scan-noimg"></span>'}
            <span><b>${esc(c.name)}</b><small>${esc(c.setName)} · #${esc(c.localId)}</small></span>
          </button>`,
          )
          .join('')}
      </div>
      <button type="button" class="btn" data-act="resume">${esc(t('scan.notThis'))}</button>`;
    sheet._cards = cards;
  }

  function openCard(card) {
    const ui = getLang();
    el.classList.add('is-found');
    setHint(t('scan.found', { name: card.name }));
    navigator.vibrate?.(40);
    onCard(card.id, card.langs.includes(ui) ? ui : card.langs[0]);
  }

  async function readLoop() {
    if (loopRunning) return;
    loopRunning = true;
    try {
      setHint(t('scan.loading'));
      const worker = await loadOcr();
      if (stopped) return;
      setHint(t('scan.aim'));
      while (!stopped && stream) {
        if (paused || video.readyState < 2 || !video.videoWidth) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        const reading = await readFrame(worker, video, frameBox(video, guide), frames);
        if (stopped || paused || !stream) continue;
        frames++;
        const result = await findCard(reading, previousHead).catch(() => null);
        previousHead = reading.head;
        if (stopped || paused || !stream) continue;
        if (!result) {
          setHint(t('scan.offline'));
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (result.status === 'match' && !rejected.has(result.card.id)) {
          openCard(result.card);
          return;
        }
        if (result.status === 'maybe') {
          const cards = result.cards.filter((c) => !rejected.has(c.id));
          const key = cards[0]?.name ?? '';
          const times = (seen.get(key) ?? 0) + 1;
          seen.clear();
          seen.set(key, times);
          if (cards.length && times >= CONFIRM_AFTER) showCandidates(cards);
          else setHint(t('scan.reading', { number: result.read }));
        } else {
          setHint(result.read ? t('scan.reading', { number: result.read }) : t(frames > 8 ? 'scan.tip' : 'scan.aim'));
        }
      }
    } catch (e) {
      console.error('Scanner:', e);
      if (!stopped) showError('scan.ocrFail');
    } finally {
      loopRunning = false;
    }
  }

  el.addEventListener('click', async (e) => {
    const option = e.target.closest('.scan-option');
    if (option) {
      const card = sheet._cards?.find((c) => c.id === option.dataset.id);
      if (card) openCard(card);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') onClose();
    else if (act === 'search') onSearch();
    else if (act === 'resume') {
      (sheet._cards ?? []).forEach((c) => rejected.add(c.id));
      seen.clear();
      sheet.hidden = true;
      paused = false;
      setHint(t('scan.aim'));
    } else if (act === 'retry') {
      el.classList.remove('is-error');
      sheet.hidden = true;
      startCamera();
    } else if (act === 'torch') {
      const on = torchBtn.getAttribute('aria-pressed') !== 'true';
      try {
        await stream?.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] });
        torchBtn.setAttribute('aria-pressed', String(on));
      } catch {}
    }
  });

  // the camera is released while the app is in the background
  const onVisibility = () => {
    if (document.hidden) stopCamera();
    else if (!stopped && !stream && !el.classList.contains('is-error')) startCamera();
  };
  document.addEventListener('visibilitychange', onVisibility);

  startCamera();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
    document.documentElement.classList.remove('scan-open');
    stopCamera();
    releaseOcrLater();
  };
}
