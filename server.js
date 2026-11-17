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
// On Vercel there is no persistent disk nor background processes: decks are read from Vercel Blob
// (uploaded by GitHub Actions) and the update scheduler is not used.
const ON_VERCEL = Boolean(process.env.VERCEL);
const REMOTE_DATA = ON_VERCEL || Boolean(process.env.DATA_URL);
const REMOTE_TTL_MS = Number(process.env.DATA_TTL_SECONDS ?? 300) * 1000;

let db = { updatedAt: null, sources: {}, decks: [], byId: new Map(), standard: null, expanded: null };
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
    console.error(`Could not read ${DATA_FILE}: ${e.message}. Keeping the previous data.`);
    return db;
  }
  ingest(raw);
  loadedMtime = s.mtimeMs;
  return db;
}

// Remote data (Vercel Blob or DATA_URL): re-checked every REMOTE_TTL_MS with If-None-Match,
// so it is only downloaded when GitHub Actions uploaded a new version.
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
      console.error(`Could not read the remote decks: ${e.message}. Keeping the previous data.`);
      remote.checkedAt = Date.now() - REMOTE_TTL_MS + 30_000; // retry in 30 s
    } finally {
      remote.pending = null;
    }
    return db;
  })();
  return remote.pending;
}

const isExpanded = (deck) => deck.format === 'expanded';

/** Index of a set of decks: card usage, names, display info and Japanese prints. */
function buildIndex(decks) {
  const byKey = new Map(); // card identity -> [{ deck, copies }]
  const byName = new Map(); // normalized name -> Set(identities)
  const cards = new Map(); // identity -> display info
  const jpPrints = new Map(); // identity -> Japanese print { set, number } (for Japan-only card sheets)
  for (const deck of decks) {
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
      if (c.set && c.number && (c.lang === 'jp' || deck.source.startsWith('pokecabook')) && !jpPrints.has(key)) jpPrints.set(key, { set: c.set, number: c.number });
      const nk = normName(c.name);
      if (!byName.has(nk)) byName.set(nk, new Set());
      byName.get(nk).add(key);
    }
    for (const [key, copies] of perDeck) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ deck, copies });
    }
  }
  for (const [key, info] of cards) info.decks = byKey.get(key).length;
  return { decks, byKey, byName, cards, jpPrints, sourceNames: new Set(decks.map((d) => d.source)) };
}

function ingest(raw) {
  const byId = new Map();
  for (const deck of raw.decks) {
    deck.archetypeKey = normName(deck.archetype);
    byId.set(deck.id, deck);
  }
  assignFamilies(raw.decks); // archetype families (e.g. every Dragapult variant)
  const standard = buildIndex(raw.decks.filter((d) => !isExpanded(d)));
  const expanded = buildIndex(raw.decks.filter(isExpanded));
  db = { updatedAt: raw.updatedAt, sources: raw.sources ?? {}, decks: raw.decks, byId, standard, expanded };
  console.log(`data loaded: ${standard.decks.length} Standard + ${expanded.decks.length} Expanded decks, ${standard.cards.size} + ${expanded.cards.size} distinct cards`);
}

/** Index for a request: Standard by default, Expanded with ?format=expanded. */
function view(req) {
  const format = req.query.format === 'expanded' ? 'expanded' : 'standard';
  const ix = db[format] ?? { decks: [], byKey: new Map(), byName: new Map(), cards: new Map(), jpPrints: new Map(), sourceNames: new Set() };
  const sources = Object.fromEntries(Object.entries(db.sources ?? {}).filter(([k]) => ix.sourceNames.has(k)));
  return { ...ix, format, sources, updatedAt: db.updatedAt, byId: db.byId };
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
app.set('trust proxy', true); // behind the Vercel proxy: req.protocol = https
// Public site URL (for canonical, Open Graph and sitemap). Without SITE_URL the request's one is used.
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

app.get('/api/meta', (req, res) => {
  const ix = view(req);
  const archetypes = archetypeStats(ix.decks);
  res.json({
    updatedAt: ix.updatedAt,
    sources: ix.sources,
    totalDecks: ix.decks.length,
    format: ix.format,
    expandedDecks: db.expanded?.decks.length ?? 0,
    totalArchetypes: archetypes.size,
    totalCards: ix.cards.size,
    scraper: scraperStatus(),
  });
});

/** Date filter (YYYY-MM-DD, inclusive). With an active filter, decks without a date are left out. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function filterByDate(list, from, to) {
  const f = ISO_DATE.test(from ?? '') ? from : null;
  const t = ISO_DATE.test(to ?? '') ? to : null;
  if (!f && !t) return list;
  return list.filter((d) => d.date && (!f || d.date >= f) && (!t || d.date <= t));
}

app.get('/api/archetypes', (req, res) => {
  const ix = view(req);
  let decks = filterByDate(ix.decks, req.query.from, req.query.to);
  if (req.query.source) decks = decks.filter((d) => d.source === req.query.source);
  const list = [...archetypeStats(decks).values()]
    .map((a) => ({ ...a, sources: [...a.sources] }))
    .sort((a, b) => b.decks - a.decks);
  res.json(list);
});

app.get('/api/decks', (req, res) => {
  const ix = view(req);
  const { source, archetype, q } = req.query;
  const limit = Math.min(Number(req.query.limit ?? 48), 200);
  const offset = Number(req.query.offset ?? 0);
  let list = filterByDate(ix.decks, req.query.from, req.query.to);
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
  // lists per archetype within the filtered set (to sort by rarity and flag unique decks)
  const perArch = new Map();
  for (const d of list) perArch.set(d.archetypeKey, (perArch.get(d.archetypeKey) ?? 0) + 1);
  const sort = String(req.query.sort ?? '');
  if (sort === 'rare' || sort === 'popular') {
    const dir = sort === 'rare' ? 1 : -1;
    list = [...list].sort(
      (a, b) =>
        dir * (perArch.get(a.archetypeKey) - perArch.get(b.archetypeKey)) ||
        a.archetypeKey.localeCompare(b.archetypeKey) || // variants of the same archetype together
        (b.date ?? '').localeCompare(a.date ?? ''),
    );
  }
  res.json({
    total: list.length,
    items: list.slice(offset, offset + limit).map((d) => ({ ...summary(d), archetypeLists: perArch.get(d.archetypeKey) })),
  });
});

app.get('/api/decks/:id', (req, res) => {
  const ix = view(req);
  const deck = ix.byId.get(req.params.id);
  if (!deck) return res.status(404).json({ error: 'Deck not found' });
  res.json({ ...summary(deck), cards: deck.cards, environment: deck.environment ?? null, articleUrl: deck.articleUrl ?? null, tournamentUrl: deck.tournamentUrl ?? null, shop: deck.shop ?? null, preview: deck.preview ?? null });
});

// No copy with an English print (tpci/EN image) = card only released in Japan so far
const isJpOnly = (c) => Boolean(c.image) && !/\/tpci\//.test(c.image);
const publicCard = (c) =>
  c && { key: c.key, name: c.name, section: c.section, attacks: c.attacks, abilities: c.abilities, image: c.image, decks: c.decks, jpOnly: isJpOnly(c) };

/**
 * Which decks/archetypes does a card appear in?
 * key  = exact identity (public/cardkey.js), can be repeated.
 * name = every version with that name (fallback only).
 */
app.get('/api/usage', (req, res) => {
  const ix = view(req);
  let keys = [].concat(req.query.key ?? []).map(String).filter(Boolean);
  const names = [].concat(req.query.name ?? []).map(String).filter(Boolean);
  for (const n of names) keys.push(...(ix.byName.get(normName(n)) ?? [cardKey(n)]));
  keys = [...new Set(keys)];
  if (!keys.length) return res.status(400).json({ error: 'Missing key or name parameter' });

  const hits = new Map(); // deckId -> { deck, copies }
  for (const k of keys)
    for (const h of ix.byKey.get(k) ?? []) {
      const prev = hits.get(h.deck.id);
      hits.set(h.deck.id, prev ? { deck: h.deck, copies: prev.copies + h.copies } : h);
    }

  const totals = archetypeStats(ix.decks);
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

  // other versions with the same name but different text (e.g. another "Moltres")
  const nameKeys = new Set(keys.map((k) => normName(k.split('|')[0])));
  const variants = [...nameKeys]
    .flatMap((nk) => [...(ix.byName.get(nk) ?? [])])
    .filter((k) => !keys.includes(k))
    .map((k) => publicCard(ix.cards.get(k)))
    .sort((a, b) => b.decks - a.decks);

  // no matches: suggest cards with similar names
  let suggestions = [];
  if (!hits.size && !variants.length) {
    const words = normName(keys[0].split('|')[0]).split(' ').filter((w) => w.length > 2 && !['ex', 'the'].includes(w));
    suggestions = [...ix.cards.values()]
      .filter((c) => words.some((w) => normName(c.name).includes(w)))
      .sort((a, b) => b.decks - a.decks)
      .slice(0, 12)
      .map(publicCard);
  }

  res.json({
    keys,
    card: publicCard(keys.map((k) => ix.cards.get(k)).find(Boolean)),
    totalDecks: ix.decks.length,
    matches: hits.size,
    archetypes,
    decks,
    partners: findPartners(ix, keys, nameKeys, [...hits.values()].map((h) => h.deck)),
    format: ix.format,
    variants,
    suggestions,
  });
});

// ---- Cards it is usually played with ("partners")
const PARTNER_STAPLE = Number(process.env.PARTNER_STAPLE ?? 0.45); // in ≥45% of ALL lists = generic staple
const PARTNER_MIN_RATE = Number(process.env.PARTNER_MIN_RATE ?? 0.4); // in ≥40% of the lists that play the card
const PARTNER_MIN_LIFT = Number(process.env.PARTNER_MIN_LIFT ?? 1.5); // ≥1.5 times more common than in the overall meta
const BASIC_ENERGY = /^(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy) energy$/;

/**
 * Partners of a card: those that appear in a good share of its lists and are much more common there than in
 * the overall meta. Staples (Boss's Orders, Ultra Ball, Poké Pad, Fezandipiti ex…), basic Energy and other
 * versions of the same card are excluded. Order: inclusion × log(lift).
 */
function findPartners(ix, keys, nameKeys, decks, limit = 6) {
  if (decks.length < 3) return [];
  const total = ix.decks.length;
  const co = new Map();
  for (const deck of decks) {
    const seen = new Set(deck.cards.map((c) => c.key ?? cardKey(c.name)));
    for (const k of seen) if (!keys.includes(k)) co.set(k, (co.get(k) ?? 0) + 1);
  }
  return [...co.entries()]
    .map(([k, n]) => {
      const info = ix.cards.get(k);
      const rate = n / decks.length;
      const base = (ix.byKey.get(k)?.length ?? n) / total;
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

/** (Translated) sheet of a card only released in Japan, from its Japanese print in the decks. */
app.get('/api/jpcard', async (req, res) => {
  const key = String(req.query.key ?? '');
  const print = db.standard?.jpPrints.get(key) ?? db.expanded?.jpPrints.get(key);
  if (!print) return res.status(404).json({ error: 'No Japanese print' });
  try {
    res.json(await fetchJpCard(print));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/** Every distinct card present in decks (sorted by number of lists). */
app.get('/api/cards', (req, res) => {
  const ix = view(req);
  res.json([...ix.cards.values()].sort((a, b) => b.decks - a.decks).map(publicCard));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Route not found' }));

let scheduler = null;
function scraperStatus() {
  if (!scheduler) return null;
  const { enabled, intervalHours, running, startedAt, lastRun, nextRun } = scheduler;
  return { enabled, intervalHours, running, startedAt, lastRun, nextRun };
}

// Locally: server with automatic updates. On Vercel: the app is only exported (used by api/index.js).
if (!ON_VERCEL) {
  await loadData();
  app.listen(PORT, () => {
    console.log(`DeckDam → http://localhost:${PORT}`);
    if (!REMOTE_DATA) scheduler = startScheduler({ root: ROOT, dataFile: DATA_FILE });
  });
}

export default app;
