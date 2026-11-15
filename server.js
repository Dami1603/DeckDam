import express from 'express';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName, cardKey } from './public/cardkey.js';
import { startScheduler } from './scheduler.js';
import { assignFamilies } from './family.js';
import { fetchJpCard } from './jpcard.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(ROOT, 'data', 'decks.json');
const PORT = Number(process.env.PORT ?? 3000);
// En Vercel no hay disco persistente ni procesos en segundo plano: los mazos se leen de Vercel Blob
// (los sube GitHub Actions) y el programador de actualizaciones no se usa.
const ON_VERCEL = Boolean(process.env.VERCEL);
const REMOTE_DATA = ON_VERCEL || Boolean(process.env.DATA_URL);
const REMOTE_TTL_MS = Number(process.env.DATA_TTL_SECONDS ?? 300) * 1000;

let db = { updatedAt: null, sources: {}, decks: [], byId: new Map(), byKey: new Map(), byName: new Map(), cards: new Map(), jpPrints: new Map() };
let loadedMtime = 0;

function loadData() {
  return REMOTE_DATA ? loadRemote() : loadLocal();
}

async function loadLocal() {
  let s;
  try {
    s = await stat(DATA_FILE);
  } catch {
    return db;
  }
  if (s.mtimeMs === loadedMtime) return db;
  let raw;
  try {
    raw = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error(`No se pudo leer ${DATA_FILE}: ${e.message}. Se mantienen los datos anteriores.`);
    return db;
  }
  ingest(raw);
  loadedMtime = s.mtimeMs;
  return db;
}

// Datos remotos (Vercel Blob o DATA_URL): se vuelven a consultar cada REMOTE_TTL_MS con If-None-Match,
// así sólo se descargan cuando GitHub Actions subió una versión nueva.
const remote = { url: process.env.DATA_URL || null, etag: null, checkedAt: 0, pending: null };
async function loadRemote() {
  if (db.decks.length && Date.now() - remote.checkedAt < REMOTE_TTL_MS) return db;
  remote.pending ??= (async () => {
    try {
      if (!remote.url) {
        const { head } = await import('@vercel/blob');
        remote.url = (await head(process.env.DATA_BLOB_PATH ?? 'decks.json')).url;
      }
      const res = await fetch(remote.url, { headers: remote.etag && db.decks.length ? { 'If-None-Match': remote.etag } : {} });
      if (res.status !== 304) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        remote.etag = res.headers.get('etag');
        ingest(raw);
      }
      remote.checkedAt = Date.now();
    } catch (e) {
      console.error(`No se pudieron leer los mazos remotos: ${e.message}. Se mantienen los datos anteriores.`);
      remote.checkedAt = Date.now() - REMOTE_TTL_MS + 30_000; // reintentar en 30 s
    } finally {
      remote.pending = null;
    }
    return db;
  })();
  return remote.pending;
}

function ingest(raw) {
  const byId = new Map();
  const byKey = new Map(); // identidad de carta -> [{ deck, copies }]
  const byName = new Map(); // nombre normalizado -> Set(identidades)
  const cards = new Map(); // identidad -> info para mostrar
  const jpPrints = new Map(); // identidad -> impresión japonesa { set, number } (para la ficha de cartas solo de Japón)

  for (const deck of raw.decks) {
    deck.archetypeKey = normName(deck.archetype);
    byId.set(deck.id, deck);
    const perDeck = new Map();
    for (const c of deck.cards) {
      const key = c.key ?? cardKey(c.name);
      perDeck.set(key, (perDeck.get(key) ?? 0) + c.count);
      const info = cards.get(key);
      if (!info || (!info.translated && c.translated !== false) || (!/_EN_/.test(info.image ?? '') && /_EN_/.test(c.image ?? ''))) {
        cards.set(key, {
          key,
          name: c.name,
          section: c.section,
          attacks: c.attacks ?? [],
          abilities: c.abilities ?? [],
          image: c.image ?? null,
          translated: c.translated !== false,
        });
      }
      if (c.set && c.number && (c.lang === 'jp' || deck.source === 'pokecabook') && !jpPrints.has(key)) jpPrints.set(key, { set: c.set, number: c.number });
      const nk = normName(c.name);
      if (!byName.has(nk)) byName.set(nk, new Set());
      byName.get(nk).add(key);
    }
    for (const [key, copies] of perDeck) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ deck, copies });
    }
  }
  assignFamilies(raw.decks); // familias de arquetipos (ej. todas las variantes de Dragapult)
  for (const [key, info] of cards) info.decks = byKey.get(key).length;
  db = { updatedAt: raw.updatedAt, sources: raw.sources ?? {}, decks: raw.decks, byId, byKey, byName, cards, jpPrints };
  console.log(`datos cargados: ${raw.decks.length} mazos, ${cards.size} cartas distintas`);
}

function coverOf(deck) {
  const poke = deck.cards.filter((c) => c.section === 'pokemon' && c.image);
  const star =
    poke.find((c) => normName(c.name) === deck.archetypeKey) ??
    poke.find((c) => /\bex$|^mega /i.test(c.name) && deck.archetypeKey.includes(normName(c.name).split(' ')[0])) ??
    [...poke].sort((a, b) => b.count - a.count)[0];
  return star?.image ?? null;
}

function summary(deck) {
  const total = deck.cards.reduce((n, c) => n + c.count, 0);
  return {
    id: deck.id,
    source: deck.source,
    format: deck.format,
    archetype: deck.archetype,
    archetypeJp: deck.archetypeJp ?? null,
    archetypeKey: deck.archetypeKey,
    family: deck.family ?? null,
    familyKey: deck.familyKey ?? null,
    archetypeShare: deck.archetypeShare,
    icons: deck.icons,
    title: deck.title,
    player: deck.player,
    placement: deck.placement,
    record: deck.record ?? null,
    event: deck.event,
    date: deck.date,
    url: deck.url,
    cover: coverOf(deck),
    totalCards: total,
  };
}

function archetypeStats(decks) {
  const map = new Map();
  for (const d of decks) {
    let a = map.get(d.archetypeKey);
    if (!a) {
      a = { key: d.archetypeKey, name: d.archetype, family: d.family, familyKey: d.familyKey, decks: 0, sources: new Set(), share: null, cover: null, icons: [] };
      map.set(d.archetypeKey, a);
    }
    a.decks++;
    a.sources.add(d.source);
    if (d.archetypeShare && !a.share) a.share = d.archetypeShare;
    if (!a.cover) a.cover = coverOf(d);
    if (!a.icons.length && d.icons?.length) a.icons = d.icons;
  }
  return map;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // detrás del proxy de Vercel: req.protocol = https
// URL pública del sitio (para canonical, Open Graph y sitemap). Sin SITE_URL se usa la del pedido.
const siteUrl = (req) => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
let indexTemplate = null;
app.get(['/', '/index.html'], async (req, res, next) => {
  try {
    indexTemplate ??= await readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
    if (process.env.NODE_ENV !== 'production') indexTemplate = await readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
    res.type('html').send(indexTemplate.replaceAll('%SITE_URL%', siteUrl(req)));
  } catch (e) {
    next(e);
  }
});
app.get(['/robots.txt', '/api/robots.txt'], (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`);
});
app.get(['/sitemap.xml', '/api/sitemap.xml'], (req, res) => {
  const lastmod = (db.updatedAt ?? new Date().toISOString()).slice(0, 10);
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `  <url><loc>${siteUrl(req)}/</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n</urlset>\n`,
  );
});
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], index: false }));

app.use('/api', async (_req, _res, next) => {
  try {
    await loadData();
  } catch (e) {
    console.error(e);
  }
  next();
});

app.get('/api/meta', (_req, res) => {
  const archetypes = archetypeStats(db.decks);
  res.json({
    updatedAt: db.updatedAt,
    sources: db.sources,
    totalDecks: db.decks.length,
    totalArchetypes: archetypes.size,
    totalCards: db.cards.size,
    scraper: scraperStatus(),
  });
});

/** Filtro de fecha (YYYY-MM-DD, inclusive). Con filtro activo, los mazos sin fecha quedan afuera. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function filterByDate(list, from, to) {
  const f = ISO_DATE.test(from ?? '') ? from : null;
  const t = ISO_DATE.test(to ?? '') ? to : null;
  if (!f && !t) return list;
  return list.filter((d) => d.date && (!f || d.date >= f) && (!t || d.date <= t));
}

app.get('/api/archetypes', (req, res) => {
  let decks = filterByDate(db.decks, req.query.from, req.query.to);
  if (req.query.source) decks = decks.filter((d) => d.source === req.query.source);
  const list = [...archetypeStats(decks).values()]
    .map((a) => ({ ...a, sources: [...a.sources] }))
    .sort((a, b) => b.decks - a.decks);
  res.json(list);
});

app.get('/api/decks', (req, res) => {
  const { source, archetype, q } = req.query;
  const limit = Math.min(Number(req.query.limit ?? 48), 200);
  const offset = Number(req.query.offset ?? 0);
  let list = filterByDate(db.decks, req.query.from, req.query.to);
  if (source) list = list.filter((d) => d.source === source);
  if (archetype) list = list.filter((d) => d.archetypeKey === archetype);
  else if (req.query.family) list = list.filter((d) => d.familyKey === req.query.family);
  if (q) {
    const nq = normName(String(q));
    list = list.filter(
      (d) =>
        normName(d.archetype).includes(nq) ||
        (d.archetypeJp ?? '').includes(String(q)) ||
        normName(d.player ?? '').includes(nq) ||
        normName(d.event ?? '').includes(nq) ||
        d.cards.some((c) => normName(c.name).includes(nq)),
    );
  }
  // listas por arquetipo dentro de lo filtrado (para ordenar por rareza y marcar mazos únicos)
  const perArch = new Map();
  for (const d of list) perArch.set(d.archetypeKey, (perArch.get(d.archetypeKey) ?? 0) + 1);
  const sort = String(req.query.sort ?? '');
  if (sort === 'rare' || sort === 'popular') {
    const dir = sort === 'rare' ? 1 : -1;
    list = [...list].sort(
      (a, b) =>
        dir * (perArch.get(a.archetypeKey) - perArch.get(b.archetypeKey)) ||
        a.archetypeKey.localeCompare(b.archetypeKey) || // variantes del mismo arquetipo juntas
        (b.date ?? '').localeCompare(a.date ?? ''),
    );
  }
  res.json({
    total: list.length,
    items: list.slice(offset, offset + limit).map((d) => ({ ...summary(d), archetypeLists: perArch.get(d.archetypeKey) })),
  });
});

app.get('/api/decks/:id', (req, res) => {
  const deck = db.byId.get(req.params.id);
  if (!deck) return res.status(404).json({ error: 'Mazo no encontrado' });
  res.json({ ...summary(deck), cards: deck.cards, environment: deck.environment ?? null, articleUrl: deck.articleUrl ?? null, tournamentUrl: deck.tournamentUrl ?? null, shop: deck.shop ?? null, preview: deck.preview ?? null });
});

// Sin ninguna copia con impresión en inglés (imagen tpci/EN) = carta que todavía sólo salió en Japón
const isJpOnly = (c) => Boolean(c.image) && !/\/tpci\//.test(c.image);
const publicCard = (c) =>
  c && { key: c.key, name: c.name, section: c.section, attacks: c.attacks, abilities: c.abilities, image: c.image, decks: c.decks, jpOnly: isJpOnly(c) };

/**
 * ¿En qué mazos/arquetipos aparece una carta?
 * key  = identidad exacta (public/cardkey.js), se puede repetir.
 * name = todas las versiones con ese nombre (sólo como respaldo).
 */
app.get('/api/usage', (req, res) => {
  let keys = [].concat(req.query.key ?? []).map(String).filter(Boolean);
  const names = [].concat(req.query.name ?? []).map(String).filter(Boolean);
  for (const n of names) keys.push(...(db.byName.get(normName(n)) ?? [cardKey(n)]));
  keys = [...new Set(keys)];
  if (!keys.length) return res.status(400).json({ error: 'Falta el parámetro key o name' });

  const hits = new Map(); // deckId -> { deck, copies }
  for (const k of keys)
    for (const h of db.byKey.get(k) ?? []) {
      const prev = hits.get(h.deck.id);
      hits.set(h.deck.id, prev ? { deck: h.deck, copies: prev.copies + h.copies } : h);
    }

  const totals = archetypeStats(db.decks);
  const groups = new Map();
  for (const { deck, copies } of hits.values()) {
    let g = groups.get(deck.archetypeKey);
    if (!g) {
      const t = totals.get(deck.archetypeKey);
      g = { key: deck.archetypeKey, name: deck.archetype, totalDecks: t.decks, withCard: 0, copies: 0, sources: new Set(), cover: t.cover, icons: t.icons, share: t.share };
      groups.set(deck.archetypeKey, g);
    }
    g.withCard++;
    g.copies += copies;
    g.sources.add(deck.source);
  }

  const archetypes = [...groups.values()]
    .map((g) => ({
      key: g.key,
      name: g.name,
      totalDecks: g.totalDecks,
      withCard: g.withCard,
      rate: g.withCard / g.totalDecks,
      avgCopies: Math.round((g.copies / g.withCard) * 10) / 10,
      sources: [...g.sources],
      cover: g.cover,
      icons: g.icons,
      share: g.share,
    }))
    .sort((a, b) => b.rate - a.rate || b.withCard - a.withCard);

  const decks = [...hits.values()]
    .sort((a, b) => (b.deck.date ?? '').localeCompare(a.deck.date ?? ''))
    .map(({ deck, copies }) => ({ ...summary(deck), copies }));

  // otras versiones con el mismo nombre pero distinto texto (ej. otro "Moltres")
  const nameKeys = new Set(keys.map((k) => normName(k.split('|')[0])));
  const variants = [...nameKeys]
    .flatMap((nk) => [...(db.byName.get(nk) ?? [])])
    .filter((k) => !keys.includes(k))
    .map((k) => publicCard(db.cards.get(k)))
    .sort((a, b) => b.decks - a.decks);

  // sin coincidencias: sugerir cartas con nombres parecidos
  let suggestions = [];
  if (!hits.size && !variants.length) {
    const words = normName(keys[0].split('|')[0]).split(' ').filter((w) => w.length > 2 && !['ex', 'the'].includes(w));
    suggestions = [...db.cards.values()]
      .filter((c) => words.some((w) => normName(c.name).includes(w)))
      .sort((a, b) => b.decks - a.decks)
      .slice(0, 12)
      .map(publicCard);
  }

  res.json({
    keys,
    card: publicCard(keys.map((k) => db.cards.get(k)).find(Boolean)),
    totalDecks: db.decks.length,
    matches: hits.size,
    archetypes,
    decks,
    partners: findPartners(keys, nameKeys, [...hits.values()].map((h) => h.deck)),
    variants,
    suggestions,
  });
});

// ---- Cartas con las que se suele jugar ("compañeras")
const PARTNER_STAPLE = Number(process.env.PARTNER_STAPLE ?? 0.45); // en ≥45% de TODAS las listas = staple genérica
const PARTNER_MIN_RATE = Number(process.env.PARTNER_MIN_RATE ?? 0.4); // en ≥40% de las listas que usan la carta
const PARTNER_MIN_LIFT = Number(process.env.PARTNER_MIN_LIFT ?? 1.5); // ≥1.5 veces más común que en el meta general
const BASIC_ENERGY = /^(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy) energy$/;

/**
 * Compañeras de una carta: las que aparecen en buena parte de sus listas y son bastante más comunes ahí que en
 * el meta en general. Se descartan las staples (Boss's Orders, Ultra Ball, Poké Pad, Fezandipiti ex…), las
 * energías básicas y las otras versiones de la misma carta. Orden: inclusión × log(afinidad).
 */
function findPartners(keys, nameKeys, decks, limit = 6) {
  if (decks.length < 3) return [];
  const total = db.decks.length;
  const co = new Map();
  for (const deck of decks) {
    const seen = new Set(deck.cards.map((c) => c.key ?? cardKey(c.name)));
    for (const k of seen) if (!keys.includes(k)) co.set(k, (co.get(k) ?? 0) + 1);
  }
  return [...co.entries()]
    .map(([k, n]) => {
      const info = db.cards.get(k);
      const rate = n / decks.length;
      const base = (db.byKey.get(k)?.length ?? n) / total;
      return { info, rate, base, lift: rate / base };
    })
    .filter(
      (p) =>
        p.info &&
        p.base < PARTNER_STAPLE &&
        p.rate >= PARTNER_MIN_RATE &&
        p.lift >= PARTNER_MIN_LIFT &&
        !BASIC_ENERGY.test(normName(p.info.name)) &&
        !nameKeys.has(normName(p.info.name)),
    )
    .sort((a, b) => b.rate * Math.log(b.lift) - a.rate * Math.log(a.lift))
    .slice(0, limit)
    .map((p) => ({ ...publicCard(p.info), rate: Math.round(p.rate * 100) / 100, base: Math.round(p.base * 100) / 100 }));
}

/** Ficha (traducida) de una carta que sólo salió en Japón, a partir de su impresión japonesa en los mazos. */
app.get('/api/jpcard', async (req, res) => {
  const print = db.jpPrints.get(String(req.query.key ?? ''));
  if (!print) return res.status(404).json({ error: 'Sin impresión japonesa' });
  try {
    res.json(await fetchJpCard(print));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/** Todas las cartas distintas presentes en mazos (ordenadas por cantidad de listas). */
app.get('/api/cards', (_req, res) => {
  res.json([...db.cards.values()].sort((a, b) => b.decks - a.decks).map(publicCard));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

let scheduler = null;
function scraperStatus() {
  if (!scheduler) return null;
  const { enabled, intervalHours, running, startedAt, lastRun, nextRun } = scheduler;
  return { enabled, intervalHours, running, startedAt, lastRun, nextRun };
}

// En tu PC: servidor con actualización automática. En Vercel: sólo se exporta la app (la usa api/index.js).
if (!ON_VERCEL) {
  await loadData();
  app.listen(PORT, () => {
    console.log(`DeckDam → http://localhost:${PORT}`);
    if (!REMOTE_DATA) scheduler = startScheduler({ root: ROOT, dataFile: DATA_FILE });
  });
}

export default app;
