// DeckDam — frontend (vanilla JS, router por hash)
import { normName, cardKey, tcgdexKey, nameOfKey } from './cardkey.js';
import { t, getLang, setLang, locale, applyStatic } from './i18n.js';

const TCGDEX = 'https://api.tcgdex.net/v2';

// Expansiones legales en Standard que TCGdex todavía no marca como tales (sus cartas vienen con
// legal.standard=false y sin marca de regulación). Quitar de la lista cuando TCGdex las actualice.
const STANDARD_EXTRA_SETS = ['me06']; // Delta Reign (DLR, 6/11/2026)

/** ¿La carta es legal en Standard? (dato de TCGdex o expansión de la lista anterior) */
const isStandardLegal = (card) => Boolean(card?.legal?.standard) || STANDARD_EXTRA_SETS.includes(card?.set?.id);
const app = document.getElementById('app');
const dialog = document.getElementById('deckDialog');

// ---------------------------------------------------------------- utilidades
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const cache = new Map();
async function getJSON(url, { useCache = true } = {}) {
  if (useCache && cache.has(url)) return cache.get(url);
  const p = fetch(url).then(async (r) => {
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return r.json();
  });
  if (useCache) cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

function debounce(fn, ms) {
  let tm;
  return (...a) => {
    clearTimeout(tm);
    tm = setTimeout(() => fn(...a), ms);
  };
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => el.classList.remove('show'), 2200);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).length <= 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const h = (Date.now() - new Date(iso)) / 3600_000;
  if (h < 1) return t('ago.minutes');
  if (h < 24) return t('ago.hours', { n: Math.round(h) });
  return t('ago.days', { n: Math.round(h / 24) });
}

const pct = (x) => `${Math.round(x * 100)}%`;
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const SOURCE_LABEL = { limitless: 'Limitless', 'limitless-jp': 'City League JP', pokecabook: 'Pokecabook', pokedata: 'Pokedata' };
const srcBadge = (s) => `<span class="src ${esc(s)}">${esc(SOURCE_LABEL[s] ?? s)}</span>`;

const imgTag = (src, alt, { fallback, cls = '' } = {}) =>
  src
    ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer"${
        fallback ? ` data-fallback="${esc(fallback)}"` : ''
      }${cls ? ` class="${cls}"` : ''}>`
    : `<div class="placeholder">${esc(alt)}</div>`;

// imágenes rotas -> fallback o placeholder
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset.fallback) {
      img.src = img.dataset.fallback;
      delete img.dataset.fallback;
      return;
    }
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent = img.alt || t('img.none');
    img.replaceWith(ph);
  },
  true,
);

/** Imagen de una carta de TCGdex; si TCGdex no la tiene, la de respaldo calculada en withFallbackImages(). */
const tcgImg = (card, q = 'low') => (card?.image ? `${card.image}/${q}.webp` : card?._img?.[q === 'high' ? 'high' : 'low'] ?? null);

/** Código oficial del set (ej. "MEP", "SVP", "TWM"), desde el detalle del set en TCGdex (cacheado). */
const setAbbrev = (setId) =>
  getJSON(`${TCGDEX}/en/sets/${encodeURIComponent(setId)}`)
    .then((s) => s.abbreviation?.official ?? null)
    .catch(() => null);

const limitlessCardImg = (abbr, localId, size) =>
  abbr && /^\d+$/.test(String(localId))
    ? `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${abbr}/${abbr}_${String(localId).padStart(3, '0')}_R_EN_${size}.png`
    : null;

/**
 * TCGdex no tiene imagen de algunas cartas (ej. todas las promos MEP). Para esas se usa la imagen de Limitless,
 * armada con el código oficial del set y el número de la carta. Agrega card._img = { low, high }.
 */
async function withFallbackImages(cards) {
  const missing = cards.filter((c) => c && !c.image && !c._img);
  const sets = [...new Set(missing.map((c) => c.set?.id ?? setIdOf(c)))];
  const abbrs = new Map(await Promise.all(sets.map(async (id) => [id, await setAbbrev(id)])));
  for (const c of missing) {
    const abbr = abbrs.get(c.set?.id ?? setIdOf(c));
    const low = limitlessCardImg(abbr, c.localId, 'MD');
    if (low) c._img = { low, high: limitlessCardImg(abbr, c.localId, 'LG') };
  }
  return cards;
}
const backButton = () => `<button class="back" id="back">${t('back')}</button>`;
const bindBack = () =>
  document.getElementById('back')?.addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/')));

// ---------------------------------------------------------------- datos compartidos
const state = {
  search: { q: '', lang: null, results: null },
  used: null, // { list, byKey: Map(key -> carta), byName: Map(nombre normalizado -> [cartas]) }
  meta: null,
};

/** Idioma de las cartas (TCGdex) = idioma de la interfaz. */
const cardLangNow = () => getLang();

/** Cartas que aparecen en mazos, por identidad exacta y por nombre. */
async function loadUsedCards() {
  if (state.used) return state.used;
  let list = [];
  try {
    list = await getJSON('/api/cards');
  } catch {}
  const byKey = new Map(list.map((c) => [c.key, c]));
  const byName = new Map();
  for (const c of list) {
    const nk = normName(c.name);
    if (!byName.has(nk)) byName.set(nk, []);
    byName.get(nk).push(c);
  }
  state.used = { list, byKey, byName };
  return state.used;
}

/** Sets de TCGdex en orden cronológico, sin Pokémon TCG Pocket (serie "tcgp"). */
async function loadSets(lang) {
  try {
    const [sets, pocket] = await Promise.all([
      getJSON(`${TCGDEX}/${lang}/sets`),
      getJSON(`${TCGDEX}/${lang}/series/tcgp`).catch(() => ({ sets: [] })),
    ]);
    const pocketIds = new Set((pocket.sets ?? []).map((s) => s.id));
    return new Map(sets.map((s, i) => [s.id, { ...s, order: i, pocket: pocketIds.has(s.id) }]));
  } catch {
    return new Map();
  }
}

const isPocket = (card, sets) => Boolean(sets.get(setIdOf(card))?.pocket);

/** Detalles de varias cartas de TCGdex con concurrencia limitada. */
async function fetchDetails(lang, ids, limit = 6) {
  const out = new Map();
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, ids.length) }, async () => {
      while (i < ids.length) {
        const id = ids[i++];
        try {
          out.set(id, await getJSON(`${TCGDEX}/${lang}/cards/${encodeURIComponent(id)}`));
        } catch {}
      }
    }),
  );
  return out;
}

const keyHash = (key) => `#/k/${encodeURIComponent(key)}`;

function setIdOf(card) {
  return card.id.slice(0, card.id.length - String(card.localId).length - 1);
}

async function loadMeta() {
  const chip = document.getElementById('dataChip');
  const text = document.getElementById('dataChipText');
  try {
    const m = await getJSON('/api/meta', { useCache: false });
    state.meta = m;
    if (!m.totalDecks) {
      chip.className = 'data-chip warn';
      text.textContent = t('chip.empty');
    } else {
      chip.className = 'data-chip ok';
      text.innerHTML = `<b class="chip-num">${m.totalDecks}</b> <span class="chip-rest">${esc(t('chip.rest', { archetypes: m.totalArchetypes, ago: timeAgo(m.updatedAt) }))}</span>`;
      const lines = Object.entries(m.sources).map(([k, v]) =>
        t('chip.source', { source: SOURCE_LABEL[k] ?? k, decks: v.decks, date: new Date(v.updatedAt).toLocaleString(locale()) }),
      );
      const sc = m.scraper;
      if (sc?.enabled) {
        lines.push('', t('chip.auto', { hours: sc.intervalHours }));
        if (sc.nextRun) lines.push(t('chip.next', { date: new Date(sc.nextRun).toLocaleString(locale()) }));
        if (sc.lastRun && !sc.lastRun.ok) lines.push(t('chip.lastFail', { msg: sc.lastRun.message }));
      }
      chip.title = lines.join('\n');
    }
    // mientras se actualiza: indicador y consulta periódica hasta que termine
    clearTimeout(loadMeta.poll);
    if (m.scraper?.running) {
      chip.className = 'data-chip updating';
      text.innerHTML = `<b class="chip-num">↻</b> <span class="chip-rest">${esc(t('chip.updating'))}</span>`;
      loadMeta.wasRunning = true;
      loadMeta.poll = setTimeout(loadMeta, 20_000);
    } else if (loadMeta.wasRunning) {
      loadMeta.wasRunning = false;
      cache.clear();
      state.used = null;
      toast(t('toast.updated'));
      router();
    }
  } catch {
    chip.className = 'data-chip warn';
    text.textContent = t('chip.noServer');
  }
}

// ---------------------------------------------------------------- idioma
function syncLangSwitch() {
  document.querySelectorAll('[data-ui-lang]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.uiLang === getLang()));
}

document.querySelectorAll('[data-ui-lang]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.uiLang === getLang()) return;
    setLang(b.dataset.uiLang);
    syncLangSwitch();
    applyStatic();
    state.search.results = null; // los nombres de las cartas cambian de idioma
    loadMeta();
    // si se está viendo una carta por id, abrirla en el nuevo idioma
    const { path } = parseHash();
    const m = path.match(/^\/carta\/(en|es)\/(.+)$/);
    if (m) {
      location.replace(`#/carta/${getLang()}/${m[2]}`);
      return;
    }
    router();
  }),
);

// ---------------------------------------------------------------- SEO: título y descripción por vista
function setMeta(title, description = t('seo.desc')) {
  document.title = title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', description);
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);
}

// ---------------------------------------------------------------- tema claro / oscuro
function setTheme(theme, save = true) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#faf7f5' : '#07070a');
  if (save) {
    try {
      localStorage.setItem('ddpk.theme', theme);
    } catch {}
  }
}
setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', false);
document.getElementById('themeToggle')?.addEventListener('click', () =>
  setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'),
);

// ---------------------------------------------------------------- router
const routes = [
  [/^\/?$/, viewSearch],
  [/^\/carta\/(en|es)\/(.+)$/, (m, p, alive) => viewCard({ lang: m[1], id: decodeURIComponent(m[2]) }, p, alive)],
  [/^\/k\/(.+)$/, (m, p, alive) => viewCard({ key: decodeURIComponent(m[1]) }, p, alive)],
  [/^\/nombre\/(.+)$/, (m) => redirectByName(decodeURIComponent(m[1]))],
  [/^\/mazos$/, viewDecks],
];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [p, qs] = raw.split('?');
  return { path: p, params: new URLSearchParams(qs ?? '') };
}

let renderToken = 0;
async function router() {
  const { path, params } = parseHash();
  const token = ++renderToken;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const isDecks = path.startsWith('/mazos');
    a.classList.toggle('active', a.dataset.nav === (isDecks ? 'decks' : 'search'));
  });
  if (dialog.open) dialog.close();
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      await fn(m, params, () => token === renderToken);
      return;
    }
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', () => {
  router();
  window.scrollTo({ top: 0 });
});

function setQuery(params) {
  const { path } = parseHash();
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  history.replaceState(null, '', `#${path}${qs ? '?' + qs : ''}`);
}

// ---------------------------------------------------------------- vista: búsqueda
async function viewSearch(_m, params, alive) {
  const q = params.get('q') ?? state.search.q ?? '';
  setMeta(q.trim().length >= 2 ? t('seo.search', { q: q.trim() }) : t('seo.home'));

  app.innerHTML = `
    <section class="hero">
      <span class="eyebrow">${t('hero.eyebrow')}</span>
      <h1>${t('hero.title')}</h1>
      <p>${t('hero.text')}</p>
      <form class="searchbar" id="searchForm" role="search">
        <label class="field">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="q" type="search" autocomplete="off" placeholder="${esc(t('search.placeholder'))}" value="${esc(q)}" aria-label="${esc(t('search.aria'))}" />
        </label>
      </form>
    </section>
    <div id="results"></div>
  `;

  const input = document.getElementById('q');
  const run = (immediate) => (immediate ? doSearch(input.value, alive) : debouncedSearch(input.value, alive));
  input.addEventListener('input', () => run(false));
  document.getElementById('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    run(true);
  });

  if (q.trim().length >= 2) {
    if (state.search.results && state.search.q === q && state.search.lang === cardLangNow()) renderResults(state.search.results);
    else doSearch(q, alive);
  } else {
    renderIntro();
  }
  if (!q) input.focus();
}

// ---------------------------------------------------------------- carrusel: cartas más jugadas
let carouselTimer = null;

/** Imagen más nítida de Limitless (_MD) con la original como respaldo. */
const sharper = (src) => (src && /_SM\.png$/.test(src) ? { src: src.replace(/_SM\.png$/, '_MD.png'), fallback: src } : { src, fallback: undefined });

const CAROUSEL_TABS = [
  ['all', 'tab.all', (c) => c.section !== 'energy'],
  ['pokemon', 'tab.pokemon', (c) => c.section === 'pokemon'],
  ['trainer', 'tab.trainer', (c) => c.section === 'trainer'],
];

async function renderTopCarousel(container, tab = state.carouselTab ?? 'all') {
  state.carouselTab = tab;
  const used = await loadUsedCards();
  if (!document.body.contains(container)) return;
  const total = state.meta?.totalDecks || null;
  const filter = (CAROUSEL_TABS.find(([id]) => id === tab) ?? CAROUSEL_TABS[0])[2];
  const top = used.list.filter((c) => c.image && filter(c)).slice(0, 24);
  if (!top.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `
    <section class="carousel" aria-roledescription="carousel" aria-label="${esc(t('carousel.aria'))}">
      <div class="carousel-head">
        <div>
          <h2>${t('carousel.title')}</h2>
          <p>${t('carousel.text')}</p>
        </div>
        <div class="carousel-nav">
          <div class="seg carousel-tabs" role="tablist" aria-label="${esc(t('carousel.type'))}">
            ${CAROUSEL_TABS.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-pressed="${id === tab}" aria-selected="${id === tab}">${t(label)}</button>`).join('')}
          </div>
          <button type="button" class="carousel-btn" data-dir="-1" aria-label="${esc(t('carousel.prev'))}">‹</button>
          <button type="button" class="carousel-btn" data-dir="1" aria-label="${esc(t('carousel.next'))}">›</button>
        </div>
      </div>
      <div class="carousel-track" tabindex="0">
        ${top
          .map((c, i) => {
            const img = sharper(c.image);
            return `
          <button class="cc" data-key="${esc(c.key)}" title="${esc(c.name)}">
            <div class="cc-img">${imgTag(img.src, c.name, { fallback: img.fallback })}</div>
            <span class="cc-rank">#${i + 1}</span>
            <div class="cc-name">${esc(c.name)}</div>
            <div class="cc-sub">${t('lists', { n: c.decks })}${total ? ` · ${pct(c.decks / total)}` : ''}</div>
          </button>`;
          })
          .join('')}
      </div>
    </section>`;

  const track = container.querySelector('.carousel-track');
  track.querySelectorAll('.cc').forEach((b) => b.addEventListener('click', () => (location.hash = keyHash(b.dataset.key))));
  container.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => renderTopCarousel(container, b.dataset.tab)));
  const step = () => {
    const card = track.querySelector('.cc');
    return card ? card.getBoundingClientRect().width + 16 : 200;
  };
  const advance = (dir, cards = 1) => {
    const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    const atStart = track.scrollLeft <= 4;
    if (dir > 0 && atEnd) track.scrollTo({ left: 0, behavior: 'smooth' });
    else if (dir < 0 && atStart) track.scrollTo({ left: track.scrollWidth, behavior: 'smooth' });
    else track.scrollBy({ left: dir * step() * cards, behavior: 'smooth' });
  };
  container.querySelectorAll('.carousel-btn').forEach((b) => b.addEventListener('click', () => advance(Number(b.dataset.dir), 2)));

  // avance automático: se pausa con el mouse encima, al enfocar o al tocar; respeta "reducir movimiento"
  let paused = false;
  const pause = () => (paused = true);
  const resume = () => (paused = false);
  track.addEventListener('mouseenter', pause);
  track.addEventListener('mouseleave', resume);
  track.addEventListener('focusin', pause);
  track.addEventListener('focusout', resume);
  track.addEventListener('touchstart', pause, { passive: true });
  track.addEventListener('touchend', () => setTimeout(resume, 4000), { passive: true });
  clearInterval(carouselTimer);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  carouselTimer = setInterval(() => {
    if (!document.body.contains(track)) return clearInterval(carouselTimer);
    if (!paused && !document.hidden) advance(1);
  }, 3200);
}

function renderIntro() {
  const el = document.getElementById('results');
  if (!el) return;
  el.innerHTML = `
    <div id="topCards"></div>
    <div class="stats" style="margin-top:12px">
      <div class="stat accent"><div class="label">${t('intro.how')}</div><div class="stat-text">${t('intro.howText')}</div></div>
      <div class="stat"><div class="label">${t('intro.lists')}</div><div class="value">${state.meta?.totalDecks ?? '—'}</div></div>
      <div class="stat"><div class="label">${t('intro.archetypes')}</div><div class="value">${state.meta?.totalArchetypes ?? '—'}</div></div>
    </div>`;
  renderTopCarousel(document.getElementById('topCards'));
}

const debouncedSearch = debounce((q, alive) => doSearch(q, alive), 350);

async function doSearch(rawQ, alive) {
  const q = rawQ.trim();
  const el = document.getElementById('results');
  if (!el) return;
  setQuery({ q });
  state.search.q = q;
  setMeta(q.length >= 2 ? t('seo.search', { q }) : t('seo.home'));
  if (q.length < 2) {
    renderIntro();
    return;
  }
  el.innerHTML = `<div class="section-head"><div><h2>${t('search.searching', { q: esc(q) })}</h2></div></div>
    <div class="card-grid">${'<div class="skeleton sk-card"></div>'.repeat(12)}</div>`;

  const lang = cardLangNow();
  try {
    const [cards, sets, used] = await Promise.all([
      Promise.all([
        getJSON(`${TCGDEX}/${lang}/cards?name=${encodeURIComponent(q)}&legal.standard=true&pagination:itemsPerPage=150`),
        // + cartas de expansiones legales que TCGdex aún no marca (ver STANDARD_EXTRA_SETS)
        ...STANDARD_EXTRA_SETS.map((setId) =>
          getJSON(`${TCGDEX}/${lang}/cards?name=${encodeURIComponent(q)}&set.id=${setId}`).catch(() => []),
        ),
      ]).then((lists) => {
        const seen = new Set();
        return lists.flat().filter((c) => !seen.has(c.id) && seen.add(c.id));
      }),
      loadSets(lang),
      loadUsedCards(),
    ]);
    if (!alive() || state.search.q !== q) return;
    const rows = cards
      .filter((c) => !isPocket(c, sets))
      .map((c) => {
        const set = sets.get(setIdOf(c));
        return { ...c, setName: set?.name ?? setIdOf(c), setOrder: set?.order ?? -1, used: null };
      });

    await withFallbackImages(rows);
    if (!alive() || state.search.q !== q) return;

    // Badge exacto: para las cartas cuyo nombre se juega, se piden sus ataques y se compara
    // la identidad completa (un "Moltres" con otros ataques es otra carta).
    if (lang === 'en') {
      const candidates = rows.filter((r) => used.byName.has(normName(r.name))).slice(0, 60);
      const details = await fetchDetails('en', candidates.map((r) => r.id));
      if (!alive() || state.search.q !== q) return;
      for (const r of candidates) {
        const d = details.get(r.id);
        if (!d) continue;
        r.key = tcgdexKey(d);
        r.used = used.byKey.get(r.key) ?? null;
      }
    }
    rows.sort(
      (a, b) =>
        (b.used?.decks ?? 0) - (a.used?.decks ?? 0) ||
        Number(Boolean(b.image || b._img)) - Number(Boolean(a.image || a._img)) ||
        b.setOrder - a.setOrder,
    );
    // cartas que todavía sólo salieron en Japón (están en mazos japoneses, no en TCGdex en inglés)
    const nq = normName(q);
    const shownKeys = new Set(rows.map((r) => r.key).filter(Boolean));
    state.search.jp = used.list.filter((c) => c.jpOnly && normName(c.name).includes(nq) && !shownKeys.has(c.key)).slice(0, 24);
    state.search.results = rows;
    state.search.lang = lang;
    renderResults(rows);
  } catch (e) {
    if (!alive()) return;
    el.innerHTML = `<div class="empty"><h3>${t('search.error')}</h3><p>${t('search.errorText', { msg: esc(e.message) })}</p></div>`;
  }
}

function renderResults(rows) {
  const el = document.getElementById('results');
  if (!el) return;
  const jp = state.search.jp ?? [];
  const jpHtml = jp.length
    ? `
    <div class="section-head"><div><h2>${t('search.jpTitle')}</h2><p>${t('search.jpText')}</p></div></div>
    <div class="card-grid">
      ${jp
        .map((c) => {
          const img = sharper(c.image);
          return `
        <button class="tcg-card" data-key="${esc(c.key)}" title="${esc(c.name)}">
          <div class="img-wrap">${imgTag(img.src, c.name, { fallback: img.fallback })}</div>
          <span class="badge-used">${t('search.inLists', { n: c.decks })}</span>
          <div class="meta"><div class="name">${esc(c.name)}</div><div class="sub">${t('card.jpOnly')}</div></div>
        </button>`;
        })
        .join('')}
    </div>`
    : '';
  if (!rows.length) {
    el.innerHTML = jp.length ? jpHtml : `<div class="empty"><h3>${t('search.none')}</h3><p>${t('search.noneText')}</p></div>`;
    el.querySelectorAll('.tcg-card[data-key]').forEach((b) => b.addEventListener('click', () => (location.hash = keyHash(b.dataset.key))));
    return;
  }
  const lang = state.search.lang ?? cardLangNow();
  const playedCount = rows.filter((r) => r.used).length;
  el.innerHTML = `
    <div class="section-head">
      <div>
        <h2>${t('search.count', { n: rows.length, more: rows.length >= 150 })}</h2>
        <p>${lang === 'en' ? (playedCount ? t('search.played', { n: playedCount }) : t('search.notPlayed')) : t('search.esNote')}</p>
      </div>
    </div>
    <div class="card-grid">
      ${rows
        .map(
          (c) => `
        <button class="tcg-card" data-id="${esc(c.id)}" title="${esc(c.name)} — ${esc(c.setName)}">
          <div class="img-wrap">${imgTag(tcgImg(c), c.name)}</div>
          ${c.used ? `<span class="badge-used">${t('search.inLists', { n: c.used.decks })}</span>` : ''}
          <div class="meta"><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.setName)} · #${esc(c.localId)}</div></div>
        </button>`,
        )
        .join('')}
    </div>
    ${jpHtml}`;
  el.querySelectorAll('.tcg-card[data-id]').forEach((b) =>
    b.addEventListener('click', () => (location.hash = `#/carta/${lang}/${encodeURIComponent(b.dataset.id)}`)),
  );
  el.querySelectorAll('.tcg-card[data-key]').forEach((b) => b.addEventListener('click', () => (location.hash = keyHash(b.dataset.key))));
}

// ---------------------------------------------------------------- vista: carta + uso en mazos
async function redirectByName(name) {
  const used = await loadUsedCards();
  const key = used.byName.get(normName(name))?.[0]?.key ?? cardKey(name);
  location.replace(keyHash(key));
}

/** Busca en TCGdex la impresión más reciente (con imagen, sin Pocket) con la misma identidad. */
async function findPrint(name, key) {
  const [list, sets] = await Promise.all([
    getJSON(`${TCGDEX}/en/cards?name=${encodeURIComponent('eq:' + name)}`).catch(() => []),
    loadSets('en'),
  ]);
  const cands = list
    .filter((c) => c.image && !isPocket(c, sets))
    .sort((a, b) => (sets.get(setIdOf(b))?.order ?? -1) - (sets.get(setIdOf(a))?.order ?? -1))
    .slice(0, 24);
  for (let i = 0; i < cands.length; i += 6) {
    const batch = cands.slice(i, i + 6);
    const det = await fetchDetails('en', batch.map((c) => c.id));
    for (const c of batch) {
      const d = det.get(c.id);
      if (d && tcgdexKey(d) === key) return d;
    }
  }
  return null;
}

async function viewCard({ lang, id, key }, _params, alive) {
  app.innerHTML = `
    ${backButton()}
    <div class="detail">
      <aside class="detail-card"><div class="big skeleton"></div></aside>
      <section><div class="stats">${'<div class="stat skeleton" style="height:96px"></div>'.repeat(3)}</div></section>
    </div>`;
  bindBack();

  let card = null;
  let enCard = null;
  let cardLang = lang ?? 'en';
  try {
    if (id) {
      card = await getJSON(`${TCGDEX}/${lang}/cards/${encodeURIComponent(id)}`);
      enCard = lang === 'en' ? card : await getJSON(`${TCGDEX}/en/cards/${encodeURIComponent(id)}`).catch(() => null);
      key = tcgdexKey(enCard ?? card);
    }
  } catch (e) {
    if (!alive()) return;
    app.innerHTML = `<div class="empty"><h3>${t('card.notFound')}</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  let usage;
  try {
    usage = await getJSON(`/api/usage?key=${encodeURIComponent(key)}`);
  } catch {
    usage = { keys: [key], card: null, matches: 0, totalDecks: 0, archetypes: [], decks: [], variants: [], suggestions: [] };
  }
  if (!alive()) return;

  if (!id) {
    enCard = await findPrint(usage.card?.name ?? nameOfKey(key), key);
    card = enCard;
    // sin impresión en inglés: ficha de la carta japonesa (traducida por Limitless)
    if (!card) card = await getJSON(`/api/jpcard?key=${encodeURIComponent(key)}`).catch(() => null);
    // en español: la misma impresión con sus textos en español (si TCGdex la tiene)
    if (enCard && getLang() !== 'en') {
      const localized = await getJSON(`${TCGDEX}/${getLang()}/cards/${encodeURIComponent(enCard.id)}`).catch(() => null);
      if (localized) {
        card = localized;
        cardLang = getLang();
      }
    }
    if (!alive()) return;
  }
  if (card && !card.image) {
    if (enCard?.image) card._img = { low: `${enCard.image}/low.webp`, high: `${enCard.image}/high.webp` };
    else await withFallbackImages([card]);
    if (!alive()) return;
  }
  renderCardDetail({ card, enCard, cardLang, key, usage });
}

function legalTag(card) {
  if (card?.jpOnly) {
    return `<span class="tag ${card.legal?.standard ? 'ok' : 'no'}">${card.legal?.standard ? t('legal.jp') : t('legal.no')}</span><span class="tag jp">${t('card.jpOnly')}</span>`;
  }
  if (!card?.legal) return '';
  const ok = isStandardLegal(card);
  return `<span class="tag ${ok ? 'ok' : 'no'}">${ok ? t('legal.yes') : t('legal.no')}</span>`;
}

/** Precio de TCGplayer (USD) por versión, con link al producto. */
function renderPrice(card) {
  const tp = card?.pricing?.tcgplayer;
  if (!tp) return '';
  const variants = Object.entries(tp).filter(
    ([, v]) => v && typeof v === 'object' && [v.marketPrice, v.midPrice, v.lowPrice].some((x) => typeof x === 'number'),
  );
  if (!variants.length) return '';
  const productId = variants.find(([, v]) => v.productId)?.[1].productId;
  const rows = variants
    .map(([kind, v]) => {
      const main = v.marketPrice ?? v.midPrice ?? v.lowPrice;
      const label = t(`price.${kind}`) === `price.${kind}` ? kind : t(`price.${kind}`);
      return `
        <div class="price-row">
          <span class="price-kind">${esc(label)}</span>
          <span class="price-main" title="${esc(t('price.market'))}">${usd(main)}</span>
          ${typeof v.lowPrice === 'number' ? `<span class="price-low">${t('price.low')} ${usd(v.lowPrice)}</span>` : ''}
        </div>`;
    })
    .join('');
  return `
    <div class="price">
      <div class="price-head">
        <span class="price-title">${t('price.title')}</span>
        ${tp.updated ? `<span class="price-date">${t('price.updated', { date: fmtDate(tp.updated) })}</span>` : ''}
      </div>
      ${rows}
      ${productId ? `<a class="price-link" href="https://www.tcgplayer.com/product/${encodeURIComponent(productId)}" target="_blank" rel="noopener">${t('price.buy')}</a>` : ''}
    </div>`;
}

function renderCardDetail({ card, enCard, cardLang, key, usage }) {
  const displayName = card?.name ?? usage.card?.name ?? nameOfKey(key);
  setMeta(t('seo.card', { name: displayName }), t('seo.cardDesc', { name: displayName, n: usage.matches, a: usage.archetypes.length }));
  const enName = enCard?.name ?? usage.card?.name ?? displayName;
  const bigImg = card ? tcgImg(card, 'high') : usage.card?.image;

  const facts = [];
  if (card) {
    facts.push([t('fact.set'), `${esc(card.set?.name ?? '')} <span style="color:var(--muted)">#${esc(card.localId)}</span>`]);
    facts.push([t('fact.category'), esc([card.category, card.stage, card.trainerType, card.energyType].filter(Boolean).join(' · '))]);
    if (card.hp) facts.push([t('fact.hp'), esc(card.hp)]);
    if (card.types?.length) facts.push([t('fact.type'), card.types.map((ty) => `${energyIcon(ty, 18)} ${esc(ty)}`).join(' ')]);
  }
  if (card?.rarity) facts.push([t('fact.rarity'), esc(card.rarity)]);
  if (card?.regulationMark) facts.push([t('fact.regulation'), esc(card.regulationMark)]);
  if (card?.illustrator) facts.push([t('fact.illustrator'), esc(card.illustrator)]);

  const best = usage.archetypes[0];
  const avgAll = usage.decks.length ? usage.decks.reduce((n, d) => n + d.copies, 0) / usage.decks.length : 0;

  let verdict = '';
  if (usage.matches) {
    const strong = usage.archetypes.filter((a) => a.rate >= 0.5);
    verdict = t('verdict.best', { name: esc(best.name), rate: pct(best.rate), copies: best.avgCopies });
    if (strong.length > 1) verdict += t('verdict.also', { list: strong.slice(1, 4).map((a) => `<b>${esc(a.name)}</b>`).join(', ') });
    if (usage.archetypes.length >= 6 && strong.length < 2) verdict += t('verdict.flex');
  }

  const variantsHtml = usage.variants?.length
    ? `
      <div class="section-head"><div>
        <h2>${usage.matches ? t('variants.other', { name: esc(enName) }) : t('variants.played', { name: esc(enName) })}</h2>
        <p>${t('variants.text')}</p>
      </div></div>
      <div class="variant-list">
        ${usage.variants
          .map(
            (v) => `
          <button class="variant" data-key="${esc(v.key)}">
            <div class="variant-img">${imgTag(v.image, v.name)}</div>
            <div class="variant-body">
              <div class="variant-name">${esc(v.name)}</div>
              <div class="variant-moves">${esc([...(v.abilities ?? []), ...(v.attacks ?? [])].join(' · ') || t('variants.trainer'))}</div>
              <div class="variant-count">${t('variants.in', { n: v.decks })}</div>
            </div>
          </button>`,
          )
          .join('')}
      </div>`
    : '';

  const archHtml = usage.archetypes
    .map(
      (a) => `
    <button class="arch-row" data-key="${esc(a.key)}" aria-pressed="false">
      <div class="arch-thumb">${imgTag(a.cover, a.name)}</div>
      <div>
        <div class="arch-name">${esc(a.name)} ${a.sources.map(srcBadge).join(' ')}</div>
        <div class="arch-sub">${t('arch.sub', { with: a.withCard, total: a.totalDecks, copies: a.avgCopies })}${a.share ? t('arch.share', { share: esc(a.share) }) : ''}</div>
        <div class="bar"><span style="width:${Math.max(4, a.rate * 100)}%"></span></div>
      </div>
      <div class="arch-rate">${pct(a.rate)}<small>${t('arch.inclusion')}</small></div>
    </button>`,
    )
    .join('');

  const suggestionsHtml = usage.suggestions?.length
    ? `<div class="quick"><span class="quick-label">${t('empty.maybe')}</span>${usage.suggestions
        .map((s) => `<button class="chip" data-key="${esc(s.key)}">${esc(s.name)} <small>${s.decks}</small></button>`)
        .join('')}</div>`
    : '';

  // cartas con las que se suele jugar (calculadas en el servidor, sin staples genéricas)
  const partnersHtml = !usage.matches
    ? ''
    : usage.partners?.length
    ? `
      <div class="section-head"><div><h2>${t('partners.title')}</h2><p>${t('partners.text')}</p></div></div>
      <div class="partner-grid">
        ${usage.partners
          .map((p) => {
            const img = sharper(p.image);
            return `
          <button class="partner" data-key="${esc(p.key)}" title="${esc(p.name)}">
            <div class="partner-img">${imgTag(img.src, p.name, { fallback: img.fallback })}</div>
            <div class="partner-name">${esc(p.name)}</div>
            <div class="partner-rate">${t('partners.rate', { rate: pct(p.rate) })}</div>
            <div class="partner-base">${t('partners.base', { base: pct(p.base) })}</div>
          </button>`;
          })
          .join('')}
      </div>`
    : `<p class="partners-none">${t('partners.none')}</p>`;

  const mainHtml = usage.matches
    ? `
      ${partnersHtml}
      <div class="section-head"><div><h2>${t('arch.title')}</h2><p>${t('arch.text')}</p></div></div>
      <div class="arch-list" id="archList">${archHtml}</div>
      ${variantsHtml}
      <div class="section-head"><div><h2 id="listsTitle"></h2><p>${t('lists.text')}</p></div></div>
      <div class="deck-grid" id="deckGrid"></div>`
    : `
      <div class="empty" style="margin-top:22px">
        <h3>${t('empty.version', { name: esc(enName) })}</h3>
        <p>${t('empty.versionText', { n: usage.totalDecks, variants: Boolean(usage.variants?.length) })}</p>
        ${suggestionsHtml}
      </div>
      ${variantsHtml}`;

  app.innerHTML = `
    ${backButton()}
    <div class="detail">
      <aside class="detail-card">
        <div class="big">${imgTag(bigImg, displayName, { fallback: card ? tcgImg(card, 'low') : undefined })}</div>
        <div>
          <h1>${esc(displayName)}</h1>
          ${cardLang !== 'en' && enName && enName !== displayName ? `<div class="en-name">${t('card.inEnglish', { name: esc(enName) })}</div>` : ''}
          ${renderCardText(card, usage.card)}
          ${renderPrice(enCard?.pricing ? enCard : card)}
          ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
          ${card ? '' : `<p class="en-name">${t('card.noTcgdex')}</p>`}
          ${card?.jpOnly ? `<p class="en-name">${t('card.jpNote')} <a href="${esc(card.limitlessUrl)}" target="_blank" rel="noopener">${t('card.viewLimitless')}</a></p>` : ''}
          <div class="tags">${legalTag(card)}</div>
        </div>
      </aside>

      <section>
        <div class="stats">
          <div class="stat accent"><div class="label">${t('stat.appears')}</div><div class="value">${usage.matches} <small>${t('stat.of', { n: usage.totalDecks })}</small></div></div>
          <div class="stat"><div class="label">${t('stat.archetypes')}</div><div class="value">${usage.archetypes.length}</div></div>
          <div class="stat"><div class="label">${t('stat.copies')}</div><div class="value">${usage.matches ? avgAll.toFixed(1) : '—'}</div></div>
        </div>
        ${verdict ? `<div class="verdict">${verdict}</div>` : ''}
        ${mainHtml}
      </section>
    </div>`;

  bindBack();
  app.querySelectorAll('.chip[data-key], .variant[data-key], .partner[data-key]').forEach((b) => b.addEventListener('click', () => (location.hash = keyHash(b.dataset.key))));
  if (!usage.matches) return;

  const highlight = usage.keys ?? [key];
  const grid = document.getElementById('deckGrid');
  const title = document.getElementById('listsTitle');
  let filter = null;
  const draw = () => {
    const list = filter ? usage.decks.filter((d) => d.archetypeKey === filter) : usage.decks;
    title.textContent = filter
      ? t('lists.of', { name: usage.archetypes.find((a) => a.key === filter)?.name })
      : t('lists.title', { n: list.length });
    grid.innerHTML = list.map((d) => deckTile(d)).join('');
    bindDeckTiles(grid, highlight);
  };
  document.querySelectorAll('#archList .arch-row').forEach((row) =>
    row.addEventListener('click', () => {
      filter = filter === row.dataset.key ? null : row.dataset.key;
      document.querySelectorAll('#archList .arch-row').forEach((r) => r.setAttribute('aria-pressed', r.dataset.key === filter));
      draw();
      grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }),
  );
  draw();
}

// ---------------------------------------------------------------- texto de la carta (habilidades y ataques)
// Tipos de energía de TCGdex (en/es) -> símbolo y color
const ENERGY = {
  grass: ['G', '#3f9a4a'], planta: ['G', '#3f9a4a'],
  fire: ['R', '#d9472b'], fuego: ['R', '#d9472b'],
  water: ['W', '#2f7fd0'], agua: ['W', '#2f7fd0'],
  lightning: ['L', '#e8b923'], rayo: ['L', '#e8b923'],
  psychic: ['P', '#9b4fb8'], 'psíquico': ['P', '#9b4fb8'],
  fighting: ['F', '#b8642e'], lucha: ['F', '#b8642e'],
  darkness: ['D', '#2f3a44'], oscuridad: ['D', '#2f3a44'],
  metal: ['M', '#8a959e'], 'metálico': ['M', '#8a959e'],
  dragon: ['N', '#a68a2f'], 'dragón': ['N', '#a68a2f'],
  fairy: ['Y', '#d46aa0'], hada: ['Y', '#d46aa0'],
  colorless: ['C', '#cfc8c2'], incoloro: ['C', '#cfc8c2'],
};
const BY_SYMBOL = Object.fromEntries(Object.values(ENERGY).map(([s, c]) => [s, c]));

// Símbolos originales: "Pokemon SV - SymbolSheet" de aschefield (CC BY-NC-ND 3.0), usada sin modificar
// como sprite (public/assets/sv-symbolsheet-aschefield.png). Posición de cada ícono de ataque (39×40 px).
const SHEET_ICONS = { G: 389, R: 454, W: 519, L: 584, P: 649, F: 714, D: 779, M: 844, C: 909 };
const SHEET_ICON_Y = 270;

/** Ícono de energía. size = alto en px. Dragón: ícono propio (la hoja no lo trae). Hada: círculo de color. */
function energyIcon(typeOrSymbol, size = 20) {
  const ty = String(typeOrSymbol);
  const [sym, color] = ENERGY[ty.toLowerCase()] ?? (BY_SYMBOL[ty] ? [ty, BY_SYMBOL[ty]] : ['?', '#666']);
  const title = esc(sym === '?' ? ty : t(`type.${sym}`));
  const x = SHEET_ICONS[sym];
  if (sym === 'N') {
    return `<img class="sym-img" src="/assets/energy-dragon.svg" alt="${title}" title="${title}" width="${size}" height="${size}">`;
  }
  if (x == null) return `<span class="en" style="--en:${color}" title="${title}">${sym}</span>`;
  return `<span class="sym" role="img" aria-label="${title}" title="${title}" style="--x:${x};--y:${SHEET_ICON_Y};--w:39;--h:40;--s:${(size / 40).toFixed(3)}"></span>`;
}

/** Etiqueta "Ability" original de la hoja (182×38 px). */
const abilityBadge = (height = 20) =>
  `<span class="sym sym-ability" role="img" aria-label="${esc(t('ct.ability'))}" title="${esc(t('ct.ability'))}" style="--x:389;--y:561;--w:182;--h:38;--s:${(height / 38).toFixed(3)}"></span>`;

/** Efecto con símbolos de energía en línea: "{G}" -> ícono */
const effectHtml = (text) =>
  esc(text ?? '')
    // TCGdex marca el texto recordatorio con <em>…</em> (y a veces <i>/<b>): tras escapar todo,
    // se reactivan sólo esas etiquetas de formato, sin atributos
    .replace(/&lt;(\/?)(em|i|b|strong)&gt;/gi, (_, close, tag) => `<${close}${tag.toLowerCase()}>`)
    .replace(/\{([GRWLPFDMNYC])\}/g, (_, s) => energyIcon(s, 16))
    .replace(/\n+/g, '<br>');

function renderCardText(card, fallback) {
  if (!card) {
    // sin ficha en TCGdex (carta japonesa): sólo los nombres conocidos por los mazos
    const names = [...(fallback?.abilities ?? []).map((n) => [t('ct.ability'), n]), ...(fallback?.attacks ?? []).map((n) => [t('ct.attack'), n])];
    if (!names.length) return '';
    return `<div class="ct">${names.map(([k, n]) => `<div class="ct-row"><span class="ct-badge">${esc(k)}</span> <b>${esc(n)}</b></div>`).join('')}</div>`;
  }

  const parts = [];
  if (card.category !== 'Pokemon' && card.category !== 'Pokémon') {
    if (card.effect) parts.push(`<p class="ct-effect">${effectHtml(card.effect)}</p>`);
    if (card.item?.effect) parts.push(`<p class="ct-effect"><b>${esc(card.item.name ?? '')}</b> ${effectHtml(card.item.effect)}</p>`);
    return parts.length ? `<div class="ct">${parts.join('')}</div>` : '';
  }

  for (const a of card.abilities ?? []) {
    parts.push(`
      <div class="ct-ability">
        <div class="ct-head">${/^(ability|habilidad)$/i.test(a.type ?? 'Ability') ? abilityBadge(22) : `<span class="ct-badge">${esc(a.type)}</span>`}<b class="ct-ability-name">${esc(a.name)}</b></div>
        ${a.effect ? `<p>${effectHtml(a.effect)}</p>` : ''}
      </div>`);
  }
  for (const atk of card.attacks ?? []) {
    parts.push(`
      <div class="ct-attack">
        <div class="ct-head">
          <span class="ct-cost">${(atk.cost ?? []).map((c) => energyIcon(c, 22)).join('') || '<span class="ct-free">—</span>'}</span>
          <b>${esc(atk.name)}</b>
          ${atk.damage ? `<span class="ct-dmg">${esc(atk.damage)}</span>` : ''}
        </div>
        ${atk.effect ? `<p>${effectHtml(atk.effect)}</p>` : ''}
      </div>`);
  }
  const foot = [];
  if (card.weaknesses?.length) foot.push(`<span>${t('ct.weakness')} ${card.weaknesses.map((w) => energyIcon(w.type, 17) + esc(w.value ?? '')).join(' ')}</span>`);
  if (card.resistances?.length) foot.push(`<span>${t('ct.resistance')} ${card.resistances.map((r) => energyIcon(r.type, 17) + esc(r.value ?? '')).join(' ')}</span>`);
  if (card.retreat != null) foot.push(`<span>${t('ct.retreat')} ${card.retreat ? Array.from({ length: card.retreat }, () => energyIcon('C', 17)).join('') : '0'}</span>`);
  if (foot.length) parts.push(`<div class="ct-foot">${foot.join('')}</div>`);
  return parts.length ? `<div class="ct">${parts.join('')}</div>` : '';
}

// ---------------------------------------------------------------- tiles de mazo
function deckTile(d, { rarity = false } = {}) {
  const rare =
    rarity && d.archetypeLists === 1
      ? `<span class="rare-badge unique">${t('deck.unique')}</span>`
      : rarity && d.archetypeLists <= 3
      ? `<span class="rare-badge">${t('deck.rare', { n: d.archetypeLists })}</span>`
      : '';
  const icons = d.icons?.length ? `<div class="icons">${d.icons.map((src) => `<img src="${esc(src)}" alt="" loading="lazy">`).join('')}</div>` : '';
  return `
    <button class="deck-tile" data-deck="${esc(d.id)}">
      <div class="deck-cover">
        ${imgTag(d.cover, d.archetype)}
        ${srcBadge(d.source)}
        ${d.copies ? `<span class="copies">×${d.copies}</span>` : rare}
        ${icons}
      </div>
      <div class="deck-body">
        <div class="deck-arch">${esc(d.archetype)}${d.archetypeJp ? `<span class="jp">${esc(d.archetypeJp)}</span>` : ''}</div>
        <div class="deck-event" title="${esc(d.event)}">${esc(d.event ?? '')}</div>
        <div class="deck-meta">
          ${d.placement ? `<span class="place">${esc(d.placement)}</span>·` : ''}
          ${d.player ? `<span>${esc(d.player)}</span>·` : ''}
          <span>${fmtDate(d.date)}</span>
        </div>
      </div>
    </button>`;
}

function bindDeckTiles(root, highlight = []) {
  root.querySelectorAll('[data-deck]').forEach((b) => b.addEventListener('click', () => openDeck(b.dataset.deck, highlight)));
}

// ---------------------------------------------------------------- diálogo de mazo
const SECTIONS = ['pokemon', 'trainer', 'energy'];

async function openDeck(id, highlight = []) {
  dialog.innerHTML = `<div style="padding:60px;display:grid;place-items:center"><div class="spinner"></div></div>`;
  if (!dialog.open) dialog.showModal();
  let d;
  try {
    d = await getJSON(`/api/decks/${encodeURIComponent(id)}`);
  } catch (e) {
    dialog.innerHTML = `<div class="empty" style="margin:24px"><h3>${t('deck.openError')}</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  const hl = new Set(highlight);
  const sectionHtml = SECTIONS.map((key) => {
    const cards = d.cards.filter((c) => c.section === key);
    if (!cards.length) return '';
    const n = cards.reduce((s, c) => s + c.count, 0);
    return `
      <div class="dd-section">
        <h3>${t(`section.${key}`)} <small>${n}</small></h3>
        <div class="dd-cards">
          ${cards
            .map(
              (c) => `
            <button class="dd-card ${hl.has(c.key ?? cardKey(c.name)) ? 'hl' : ''}" data-key="${esc(c.key ?? cardKey(c.name))}" title="${esc(
                [c.name, ...(c.abilities ?? []).map((a) => `${t('ct.ability')}: ${a}`), ...(c.attacks ?? []).map((a) => `${t('ct.attack')}: ${a}`)].join('\n'),
              )}\n\n${esc(t('deck.cardTitle'))}">
              <div class="img-wrap">${imgTag(c.image, c.name)}</div>
              <span class="n">${c.count}</span>
              <div class="cap">${esc(c.name)}${c.jpName && c.jpName !== c.name ? `<span>${esc(c.jpName)}</span>` : ''}</div>
            </button>`,
            )
            .join('')}
        </div>
      </div>`;
  }).join('');

  const link = (href, label) => `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;
  const srcLink =
    d.source === 'limitless'
      ? link(d.url, t('deck.viewLimitless'))
      : d.source === 'pokedata'
      ? link(d.url, t('deck.viewPokedata'))
      : d.source === 'limitless-jp'
      ? `${link(d.url, t('deck.viewList'))} ${d.tournamentUrl ? link(d.tournamentUrl, t('deck.viewTournament')) : ''}`
      : `${d.articleUrl ? link(d.articleUrl, t('deck.viewPokecabook')) : ''} ${link(d.url, t('deck.officialJp'))}`;

  dialog.innerHTML = `
    <div class="dd-hero">
      <div class="art" style="background-image:url('${esc(d.cover ?? '')}')"></div>
      <button class="dd-close" aria-label="${esc(t('deck.close'))}" id="ddClose">✕</button>
      ${srcBadge(d.source)}
      <h2 id="deckDialogTitle">${d.icons?.length ? `<span class="dd-icons">${d.icons.map((src) => `<img src="${esc(src)}" alt="" loading="lazy">`).join('')}</span>` : ''}${esc(d.archetype)}</h2>
      ${d.archetypeJp ? `<div class="jp">${esc(d.archetypeJp)}</div>` : ''}
      <div class="meta">
        ${d.placement ? `<span><b>${esc(d.placement)}</b></span>` : ''}
        ${d.event ? `<span>${esc(d.event)}</span>` : ''}
        ${d.player ? `<span>${esc(d.player)}</span>` : ''}
        ${d.record ? `<span>${t('deck.record', { r: esc(d.record) })}</span>` : ''}
        ${d.date ? `<span>${fmtDate(d.date)}</span>` : ''}
        ${d.environment ? `<span>${esc(d.environment)}</span>` : ''}
        <span>${t('deck.cards', { n: d.totalCards })}</span>
      </div>
      <div class="dd-actions">
        <button class="btn primary" id="ddCopy">${t('deck.copy')}</button>
        ${srcLink}
      </div>
    </div>
    <div class="dd-body">${sectionHtml}</div>`;

  document.getElementById('ddClose').addEventListener('click', () => dialog.close());
  document.getElementById('ddCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(decklistText(d));
      toast(t('deck.copied'));
    } catch {
      toast(t('deck.copyFail'));
    }
  });
  dialog.querySelectorAll('.dd-card').forEach((b) =>
    b.addEventListener('click', () => {
      dialog.close();
      location.hash = keyHash(b.dataset.key);
    }),
  );
}

/** Formato de importación de PTCG Live (siempre en inglés: es lo que acepta el juego). */
function decklistText(d) {
  const label = { pokemon: 'Pokémon', trainer: 'Trainer', energy: 'Energy' };
  return SECTIONS.map((key) => {
    const cards = d.cards.filter((c) => c.section === key);
    if (!cards.length) return '';
    const n = cards.reduce((s, c) => s + c.count, 0);
    const lines = cards.map((c) => {
      const enSet = c.image?.match(/\/tpci\/([A-Za-z0-9-]+)\/\1_(\w+?)_R_EN/);
      const setNum = d.source !== 'pokecabook' && c.lang !== 'jp' && c.set ? `${c.set} ${c.number}` : enSet ? `${enSet[1]} ${Number(enSet[2]) || enSet[2]}` : '';
      return `${c.count} ${c.name}${setNum ? ' ' + setNum : ''}`;
    });
    return `${label[key]}: ${n}\n${lines.join('\n')}`;
  })
    .filter(Boolean)
    .join('\n\n');
}

dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close(); // clic en el backdrop
});

// ---------------------------------------------------------------- vista: galería
async function viewDecks(_m, params, alive) {
  setMeta(t('seo.gallery'));
  if (!state.meta) await loadMeta(); // las fuentes disponibles definen los filtros
  if (!alive()) return;
  const f = {
    source: params.get('source') ?? '',
    arch: params.get('arch') ?? '',
    family: params.get('family') ?? '',
    q: params.get('q') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    sort: params.get('sort') ?? '',
  };
  // atajos de fecha: últimos N días hasta hoy; "custom" muestra los dos campos
  const isoDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const daysAgo = (n) => isoDay(new Date(Date.now() - n * 86400_000));
  const PRESETS = [['any', 0], ['7', 7], ['30', 30], ['90', 90]];
  const presetOf = () => {
    if (!f.from && !f.to) return 'any';
    const hit = PRESETS.find(([, n]) => n && f.from === daysAgo(n) && !f.to);
    return hit ? hit[0] : 'custom';
  };
  let datePreset = presetOf();
  app.innerHTML = `
    <div class="section-head" style="margin-top:8px">
      <div>
        <h2 style="font-size:30px">${t('gallery.title')}</h2>
        <p>${t('gallery.text')}</p>
      </div>
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="${esc(t('gallery.source'))}">
        <button type="button" data-src="" aria-pressed="${!f.source}">${t('gallery.all')}</button>
        ${Object.keys(state.meta?.sources ?? { limitless: 1 })
          .map((s) => `<button type="button" data-src="${esc(s)}" aria-pressed="${f.source === s}">${esc(SOURCE_LABEL[s] ?? s)}</button>`)
          .join('')}
      </div>
      <input class="input" id="dq" type="search" placeholder="${esc(t('gallery.filter'))}" value="${esc(f.q)}" />
    </div>
    <div class="toolbar date-bar">
      <div class="seg" role="group" aria-label="${esc(t('gallery.date'))}" id="datePresets">
        ${[...PRESETS.map(([id]) => id), 'custom']
          .map((id) => `<button type="button" data-date="${id}" aria-pressed="${datePreset === id}">${t(`date.${id}`)}</button>`)
          .join('')}
      </div>
      <div class="seg sort-seg" role="group" aria-label="${esc(t('gallery.sort'))}">
        ${[['', 'sort.newest'], ['rare', 'sort.rare'], ['popular', 'sort.popular']]
          .map(([id, label]) => `<button type="button" data-sort="${id}" aria-pressed="${f.sort === id}">${t(label)}</button>`)
          .join('')}
      </div>
      <div class="date-range" id="dateRange" ${datePreset === 'custom' ? '' : 'hidden'}>
        <label>${t('date.from')} <input type="date" id="dFrom" value="${esc(f.from)}"></label>
        <label>${t('date.to')} <input type="date" id="dTo" value="${esc(f.to)}"></label>
      </div>
    </div>
    <div class="arch-strip" id="archStrip"></div>
    <div class="arch-strip variant-strip" id="variantStrip" hidden></div>
    <p class="count-line" id="countLine"></p>
    <div class="deck-grid" id="deckGrid">${'<div class="skeleton" style="height:210px"></div>'.repeat(8)}</div>
    <div class="center" id="more"></div>`;

  const grid = document.getElementById('deckGrid');
  let offset = 0;
  const LIMIT = 48;

  async function load(reset) {
    if (reset) offset = 0;
    setQuery({ source: f.source, family: f.family, arch: f.arch, q: f.q, from: f.from, to: f.to, sort: f.sort });
    const qs = new URLSearchParams({ limit: LIMIT, offset, ...(f.source && { source: f.source }), ...(f.arch ? { archetype: f.arch } : f.family ? { family: f.family } : {}), ...(f.q && { q: f.q }), ...(f.from && { from: f.from }), ...(f.to && { to: f.to }), ...(f.sort && { sort: f.sort }) });
    let data;
    try {
      data = await getJSON(`/api/decks?${qs}`);
    } catch (e) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>${t('gallery.error')}</h3><p>${esc(e.message)}</p></div>`;
      return;
    }
    if (!alive()) return;
    if (reset) grid.innerHTML = '';
    if (!data.total) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>${t('gallery.none')}</h3><p>${
        state.meta?.totalDecks ? t('gallery.noMatch') : t('gallery.noData')
      }</p></div>`;
    } else {
      grid.insertAdjacentHTML('beforeend', data.items.map((d) => deckTile(d, { rarity: true })).join(''));
      bindDeckTiles(grid);
    }
    offset += data.items.length;
    document.getElementById('countLine').textContent = data.total ? t('lists', { n: data.total }) : '';
    const more = document.getElementById('more');
    more.innerHTML = offset < data.total ? `<button class="btn" id="moreBtn">${t('gallery.more', { n: data.total - offset })}</button>` : '';
    document.getElementById('moreBtn')?.addEventListener('click', () => load(false));
  }

  async function drawArchetypes() {
    let list = [];
    const aqs = new URLSearchParams({ ...(f.source && { source: f.source }), ...(f.from && { from: f.from }), ...(f.to && { to: f.to }) });
    try {
      list = await getJSON(`/api/archetypes?${aqs}`);
    } catch {}
    if (!alive()) return;
    const strip = document.getElementById('archStrip');
    const variantStrip = document.getElementById('variantStrip');

    // familias: arquetipos agrupados por su Pokémon principal (ej. todas las variantes de Dragapult)
    const families = new Map();
    for (const a of list) {
      const key = a.familyKey ?? a.key;
      const fam = families.get(key) ?? { key, name: a.family ?? a.name, decks: 0, archetypes: [], cover: null };
      fam.decks += a.decks;
      fam.archetypes.push(a);
      families.set(key, fam);
    }
    for (const fam of families.values()) {
      fam.archetypes.sort((x, y) => y.decks - x.decks);
      fam.cover = fam.archetypes[0].cover;
    }
    const famList = [...families.values()].sort((x, y) => (f.sort === 'rare' ? x.decks - y.decks : y.decks - x.decks));

    // un arquetipo elegido (por URL) implica su familia; filtros sin listas en el rango se quitan
    if (f.arch && !f.family) f.family = list.find((a) => a.key === f.arch)?.familyKey ?? '';
    if (f.family && !families.has(f.family)) f.family = '';
    if (f.arch && !families.get(f.family)?.archetypes.some((a) => a.key === f.arch)) f.arch = '';

    strip.innerHTML = famList
      .map(
        (fam) => `
      <button class="arch-pill" data-family="${esc(fam.key)}" aria-pressed="${f.family === fam.key}">
        <span class="thumb">${imgTag(fam.cover, fam.name)}</span>${esc(fam.name)} <small>${fam.decks}</small>
        ${fam.archetypes.length > 1 ? `<span class="variant-count-badge">${t('gallery.variants', { n: fam.archetypes.length })}</span>` : ''}
      </button>`,
      )
      .join('');

    const drawVariants = () => {
      const fam = families.get(f.family);
      if (!fam || fam.archetypes.length < 2) {
        variantStrip.hidden = true;
        variantStrip.innerHTML = '';
        return;
      }
      variantStrip.hidden = false;
      variantStrip.innerHTML =
        `<button class="arch-pill" data-arch="" aria-pressed="${!f.arch}">${esc(t('gallery.allFamily', { name: fam.name }))} <small>${fam.decks}</small></button>` +
        fam.archetypes
          .map(
            (a) => `
        <button class="arch-pill" data-arch="${esc(a.key)}" aria-pressed="${f.arch === a.key}">
          <span class="thumb">${imgTag(a.cover, a.name)}</span>${esc(a.name)} <small>${a.decks}</small>
        </button>`,
          )
          .join('');
      variantStrip.querySelectorAll('[data-arch]').forEach((b) =>
        b.addEventListener('click', () => {
          f.arch = b.dataset.arch;
          variantStrip.querySelectorAll('[data-arch]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.arch === f.arch));
          load(true);
        }),
      );
    };

    strip.querySelectorAll('[data-family]').forEach((b) =>
      b.addEventListener('click', () => {
        f.family = f.family === b.dataset.family ? '' : b.dataset.family;
        f.arch = '';
        strip.querySelectorAll('[data-family]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.family === f.family));
        drawVariants();
        load(true);
      }),
    );
    drawVariants();
  }

  app.querySelectorAll('[data-src]').forEach((b) =>
    b.addEventListener('click', () => {
      f.source = b.dataset.src;
      f.arch = '';
      f.family = '';
      app.querySelectorAll('[data-src]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      drawArchetypes();
      load(true);
    }),
  );
  const applyDates = async () => {
    await drawArchetypes();
    load(true);
  };
  app.querySelectorAll('[data-date]').forEach((b) =>
    b.addEventListener('click', () => {
      datePreset = b.dataset.date;
      app.querySelectorAll('[data-date]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      document.getElementById('dateRange').hidden = datePreset !== 'custom';
      if (datePreset === 'custom') {
        document.getElementById('dFrom').focus();
        return; // se aplica al elegir las fechas
      }
      const n = PRESETS.find(([id]) => id === datePreset)?.[1] ?? 0;
      f.from = n ? daysAgo(n) : '';
      f.to = '';
      document.getElementById('dFrom').value = f.from;
      document.getElementById('dTo').value = '';
      applyDates();
    }),
  );
  ['dFrom', 'dTo'].forEach((id) =>
    document.getElementById(id).addEventListener('change', () => {
      f.from = document.getElementById('dFrom').value;
      f.to = document.getElementById('dTo').value;
      if (f.from && f.to && f.from > f.to) [f.from, f.to] = [f.to, f.from];
      applyDates();
    }),
  );

  app.querySelectorAll('[data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      f.sort = b.dataset.sort;
      app.querySelectorAll('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      drawArchetypes();
      load(true);
    }),
  );

  document.getElementById('dq').addEventListener(
    'input',
    debounce((e) => {
      f.q = e.target.value.trim();
      load(true);
    }, 300),
  );

  drawArchetypes();
  load(true);
  if (params.get('deck')) openDeck(params.get('deck'));
}

// ---------------------------------------------------------------- inicio
// ?lang=es / ?lang=en en la URL elige el idioma (útil para compartir links)
const urlLang = new URLSearchParams(location.search).get('lang');
if (urlLang) setLang(urlLang);
applyStatic();
syncLangSwitch();
loadMeta().then(() => {
  if (parseHash().path === '/' && !parseHash().params.get('q')) renderIntro();
});
router();
