// Scraper de https://pokecabook.com (mazos del metajuego japonés)
// 1) índices de arquetipos, en su orden: https://pokecabook.com/archives/1417 (meta principal,
//    "環境デッキレシピまとめ") y https://pokecabook.com/archives/6132 (otros arquetipos, "その他")
// 2) en cada artículo de arquetipo, las figuras con link a un código de mazo oficial (pokemon-card.com),
//    sólo de la sección del formato vigente (ej. "30th CELEBRATION環境")
// 3) cada código de mazo -> cartas (IDs oficiales JP) -> traducción al inglés
// Además, la recopilación diaria de ganadores de Gym Battle (https://pokecabook.com/archives/27265), donde cada
// mazo lleva arriba un subtítulo (h4) con su arquetipo: ahí aparecen primero los mazos con cartas nuevas.
import * as cheerio from 'cheerio';
import { getText, mapLimit } from './http.js';
import { translateCard, saveTranslations } from './translate.js';
import { limitlessImage } from './limitless.js';

const BASE = 'https://pokecabook.com';
const DECK_RE = /pokemon-card\.com\/deck\/(?:confirm|result)\.html\/deckID\/([A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+)/;

const SECTION_BY_FIELD = {
  deck_pke: 'pokemon',
  deck_gds: 'trainer', // mercancías
  deck_tool: 'trainer', // herramientas
  deck_tech: 'trainer', // máquinas técnicas
  deck_sup: 'trainer', // partidarios
  deck_sta: 'trainer', // estadios
  deck_ajs: 'trainer', // ACE SPEC
  deck_ene: 'energy',
};

// Índices de arquetipos (ids de artículos), en orden: meta principal y luego "otros"
const HUB_IDS = (process.env.POKECABOOK_HUBS ?? '1417,6132').split(',').map((s) => s.trim()).filter(Boolean);
const HUB_URLS = HUB_IDS.map((id) => `${BASE}/archives/${id}`);

/** Arquetipos de los índices de Pokecabook, en el orden en que aparecen (sin repetir). */
async function getArticles(maxArticles) {
  const articles = [];
  for (const [i, url] of HUB_URLS.entries()) {
    let html;
    try {
      html = await getText(url, { ttlHours: 12 });
    } catch {
      continue;
    }
    const $ = cheerio.load(html);
    $('.entry-content a[href]').each((_, a) => {
      const href = $(a).attr('href');
      const id = href.match(/pokecabook\.com\/archives\/(\d+)/)?.[1];
      const name = $(a).text().replace(/\s+/g, ' ').trim();
      // sólo enlaces con nombre de arquetipo (los banners sin texto son otras secciones del sitio);
      // los índices mismos no son artículos de mazos
      if (!id || !name || HUB_IDS.includes(id) || articles.some((x) => x.id === id)) return;
      articles.push({ id, url: `${BASE}/archives/${id}`, title: name, archetypeJp: name, hub: HUB_IDS[i] });
    });
  }
  return articles.slice(0, maxArticles);
}

// Recopilaciones diarias (mazos variados, cada uno con su arquetipo en un h4)
const DAILY_IDS = (process.env.POKECABOOK_DAILY ?? '27265').split(',').map((s) => s.trim()).filter(Boolean);

async function getDailyDecks(id) {
  const url = `${BASE}/archives/${id}`;
  const html = await getText(url, { ttlHours: 6 });
  const $ = cheerio.load(html);
  const published =
    $('meta[property="article:modified_time"]').attr('content') ?? html.match(/"dateModified":"([^"]+)"/)?.[1] ?? null;
  const refDate = published ? new Date(published) : new Date();
  const entries = [];
  let section = null; // h2/h3: fecha del día ("11/14【土】ジムバトル優勝")
  let name = null; // h4: arquetipo del mazo siguiente
  $('.entry-content')
    .find('h2, h3, h4, figure')
    .each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (el.tagName === 'h2' || el.tagName === 'h3') {
        section = text;
        name = null;
        return;
      }
      if (el.tagName === 'h4') {
        name = text;
        return;
      }
      const link = $(el).find('a[href*="pokemon-card.com/deck/"]').attr('href');
      const m = link?.match(DECK_RE);
      if (!m || !name || entries.some((d) => d.code === m[1])) return;
      const caption = $(el).find('figcaption').text().replace(/\s+/g, ' ').trim() || section || '';
      entries.push({
        code: m[1],
        caption,
        archetypeJp: name,
        environment: null,
        preview: $(el).find('img').attr('src') ?? null,
        date: dateFromCaption(caption, refDate) ?? dateFromCaption(section ?? '', refDate),
        placement: placementFromCaption(caption),
      });
      name = null;
    });
  return { url, entries };
}

async function getArticleDecks(article) {
  const html = await getText(article.url, { ttlHours: 12 });
  const $ = cheerio.load(html);
  const published = $('meta[property="article:modified_time"]').attr('content')
    ?? html.match(/"dateModified":"([^"]+)"/)?.[1] ?? null;
  const refDate = published ? new Date(published) : new Date();

  const decks = [];
  let environment = null;
  $('.entry-content')
    .find('h2, figure')
    .each((_, el) => {
      if (el.tagName === 'h2') {
        environment = $(el).text().trim();
        return;
      }
      const link = $(el).find('a[href*="pokemon-card.com/deck/"]').attr('href');
      const m = link?.match(DECK_RE);
      if (!m || decks.some((d) => d.code === m[1])) return;
      const caption = $(el).find('figcaption').text().replace(/\s+/g, ' ').trim();
      decks.push({
        code: m[1],
        caption,
        environment,
        preview: $(el).find('img').attr('src') ?? null,
        date: dateFromCaption(caption, refDate),
        placement: placementFromCaption(caption),
      });
    });
  return decks;
}

// "11/14【土】Wonder GOO いわき鹿島店（福島）TOP16" -> 2026-11-14
function dateFromCaption(caption, ref) {
  const m = caption.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = ref.getFullYear();
  if (month > ref.getMonth() + 1 + 1) year -= 1; // diciembre visto en enero, etc.
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function placementFromCaption(caption) {
  if (/準優勝/.test(caption)) return '2nd';
  if (/優勝/.test(caption)) return '1st';
  const top = caption.match(/TOP\s?(\d+)/i) ?? caption.match(/ベスト\s?(\d+)/);
  if (top) return `Top ${top[1]}`;
  return null;
}

const EVENT_TERMS = [
  [/デッキレシピ平均化/, 'Average list (Pokecabook)'],
  [/シティリーグ/, 'City League'],
  [/チャンピオンズリーグ/, 'Champions League'],
  [/ジムバトル/, 'Gym Battle'],
  [/自主大会/, 'Local tournament'],
];

function stripPlacement(caption) {
  let s = caption
    .replace(/準優勝|優勝|TOP\s?\d+|ベスト\s?\d+/gi, '')
    .replace(/^\d{1,2}\/\d{1,2}【.】\s*/, '')
    .replace(/[-ー]\d+$/, '')
    .trim();
  for (const [re, es] of EVENT_TERMS) s = s.replace(re, es);
  return s.trim();
}

async function getOfficialDeck(code) {
  const html = await getText(`https://www.pokemon-card.com/deck/confirm.html/deckID/${code}`, {
    ttlHours: Infinity,
  });
  const $ = cheerio.load(html);
  const unesc = (s) => s.replace(/\\'/g, "'");
  const names = {};
  const alts = {};
  const picts = {};
  for (const [, id, v] of html.matchAll(/searchItemName\[(\d+)\]='((?:[^'\\]|\\.)*)'/g)) names[id] = unesc(v);
  for (const [, id, v] of html.matchAll(/searchItemNameAlt\[(\d+)\]='((?:[^'\\]|\\.)*)'/g)) alts[id] = unesc(v);
  for (const [, id, v] of html.matchAll(/searchItemCardPict\[(\d+)\]='([^']*)'/g)) picts[id] = v;

  const cards = [];
  for (const [field, section] of Object.entries(SECTION_BY_FIELD)) {
    const value = $(`input#${field}`).attr('value') ?? '';
    for (const part of value.split('-').filter(Boolean)) {
      const [id, count] = part.split('_');
      if (!id) continue;
      cards.push({
        jpId: id,
        jpName: alts[id] ?? names[id] ?? id,
        jpFullName: names[id] ?? null,
        count: Number(count) || 1,
        section,
        officialImage: picts[id] ? `https://www.pokemon-card.com${picts[id]}` : null,
      });
    }
  }
  if (!cards.length) throw new Error(`mazo vacío o inválido ${code}`);
  return cards;
}

const stripEx = (s) => s.replace(/\s+/g, '').replace(/ex$/i, '').replace(/^メガ/, '');

/**
 * Traduce el nombre del arquetipo (ej. "ハンマードラパルト(ノココッチ)") usando las cartas del mazo.
 * matched=false cuando el título es un apodo sin Pokémon reconocible (se usa el Pokémon principal).
 */
function translateArchetype(archetypeJp, cards) {
  const pokemon = cards.filter((c) => c.section === 'pokemon' && c.name);
  const tokens = archetypeJp.split(/[＋+()（）・/／]/).map((t) => t.replace(/\s+/g, '')).filter(Boolean);
  const matched = [];
  const compact = (s) => s.replace(/\s+/g, '');
  for (const token of tokens) {
    // puntaje: coincidencia exacta > misma forma Mega > mismo "ex" > nombre más largo.
    // (メガヤンマ es el nombre japonés de Yanmega, no una Mega: lo resuelve la coincidencia exacta)
    const tokenMega = token.startsWith('メガ');
    const tokenEx = /ex$/i.test(token);
    let best = null;
    let bestScore = -1;
    for (const c of pokemon) {
      const full = compact(c.jpName);
      const base = stripEx(c.jpName);
      if (base.length < 2) continue;
      let score;
      if (full === token) score = 1000;
      else if (token.includes(base) || base.includes(token)) {
        score = 10 + (full.startsWith('メガ') === tokenMega ? 5 : 0) + (/ex$/i.test(full) === tokenEx ? 3 : 0) + base.length / 100;
      } else continue;
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best && !matched.includes(best.name)) matched.push(best.name);
  }
  if (matched.length) return { name: matched.join(' / '), matched: true };
  const star =
    [...pokemon].sort((a, b) => b.count - a.count).find((c) => / ex$|^Mega /.test(c.name)) ??
    [...pokemon].sort((a, b) => b.count - a.count)[0];
  return { name: star ? star.name : archetypeJp, matched: false };
}

const mode = (arr) => {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

/**
 * Nombre único para todos los mazos de un artículo, o null para nombrar cada mazo por separado.
 * - Título con Pokémon reconocible en la mayoría de listas: el nombre más frecuente.
 * - Título de expansión ("30th CELEBRATION"): mazos variados, null.
 * - Apodo ("アビスアイ"): el Pokémon presente en casi todas las listas con más copias (prefiere ex/Mega).
 */
function articleArchetype(archetypeJp, deckCards) {
  if (!deckCards.length) return null;
  const results = deckCards.map((cards) => translateArchetype(archetypeJp, cards));
  const hits = results.filter((r) => r.matched);
  if (hits.length >= results.length / 2) return mode(hits.map((r) => r.name));
  if (/[A-Za-z]{3,}/.test(archetypeJp) || deckCards.length < 2) return null;
  const stats = new Map();
  for (const cards of deckCards) {
    const seen = new Set();
    for (const c of cards) {
      if (c.section !== 'pokemon' || !c.translated || seen.has(c.name)) continue;
      seen.add(c.name);
      const st = stats.get(c.name) ?? { name: c.name, decks: 0, copies: 0 };
      st.decks++;
      st.copies += c.count;
      stats.set(c.name, st);
    }
  }
  const common = [...stats.values()].filter((st) => st.decks >= Math.ceil(deckCards.length * 0.75));
  if (!common.length) return null;
  const score = (st) => st.copies / st.decks + (/ ex$|^Mega /.test(st.name) ? 1.5 : 0);
  return common.sort((a, b) => score(b) - score(a))[0].name;
}

/** Completa cartas sin traducir con la traducción de otra impresión del mismo nombre japonés. */
// Cartas que Limitless no tiene en su base japonesa
const MANUAL_TRANSLATIONS = [['スクランブルスイッチ', 'Scramble Switch']];

export function fillMissingTranslations(decks) {
  const dict = new Map(MANUAL_TRANSLATIONS);
  for (const d of decks) for (const c of d.cards) if (c.translated && c.jpName) dict.set(c.jpName.replace(/\(ACE SPEC\)$/, ''), c.name);
  let fixed = 0;
  for (const d of decks)
    for (const c of d.cards) {
      if (c.translated) continue;
      const en = dict.get(c.jpName.replace(/\(ACE SPEC\)$/, ''));
      if (en) {
        c.name = en;
        c.translated = true;
        fixed++;
      }
    }
  return fixed;
}

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function scrapePokecabook({
  maxArticles = Number(process.env.POKECABOOK_ARTICLES ?? 200),
  decksPerArticle = Number(process.env.POKECABOOK_DECKS ?? 6),
  log = console.log,
} = {}) {
  const articles = await getArticles(maxArticles);
  log(`[pokecabook] ${articles.length} arquetipos en los índices (${HUB_URLS.join(', ')})`);

  // 1) mazos de cada artículo, con su sección de formato
  const perArticle = new Map();
  for (const article of articles) {
    try {
      perArticle.set(article.id, await getArticleDecks(article));
    } catch (e) {
      log(`[pokecabook]  ✗ ${article.title}: ${e.message}`);
    }
  }

  // 2) formato vigente = la primera sección con mazos más común entre los artículos (o POKECABOOK_ENV)
  const firstEnvs = [...perArticle.values()].map((list) => list.find((e) => e.environment)?.environment).filter(Boolean);
  const envCount = new Map();
  for (const e of firstEnvs) envCount.set(e, (envCount.get(e) ?? 0) + 1);
  const currentEnv = process.env.POKECABOOK_ENV ?? [...envCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  log(`[pokecabook] formato vigente: ${currentEnv ?? '(sin secciones)'}`);

  const decks = [];
  const seenCodes = new Set(); // un mismo mazo puede figurar en dos artículos (ej. Dragapult y Hammer Dragapult)

  /** Código oficial -> cartas traducidas (o null si falla). */
  async function buildEntry(entry) {
    try {
      const raw = await getOfficialDeck(entry.code);
      const cards = [];
      for (const c of raw) {
        const t = await translateCard({ id: c.jpId, name: c.jpFullName ?? c.jpName, alt: c.jpName });
        const enImage = t.intl ? limitlessImage(t.intl.set, t.intl.number, 'en') : null;
        const jpImage = t.set ? limitlessImage(t.set, t.number, 'jp') : null;
        cards.push({
          name: t.en ?? c.jpName,
          jpName: c.jpName,
          translated: Boolean(t.en),
          count: c.count,
          section: c.section,
          set: t.set,
          number: t.number,
          enSet: t.intl?.set ?? null,
          enNumber: t.intl?.number ?? null,
          image: enImage ?? jpImage ?? c.officialImage,
        });
      }
      return { entry, cards };
    } catch (e) {
      log(`[pokecabook]  ✗ mazo ${entry.code}: ${e.message}`);
      return null;
    }
  }

  for (const [i, article] of articles.entries()) {
    const entries = (perArticle.get(article.id) ?? [])
      .filter((e) => !currentEnv || e.environment === currentEnv)
      .filter((e) => !seenCodes.has(e.code))
      .slice(0, decksPerArticle);
    if (!entries.length) continue;
    entries.forEach((e) => seenCodes.add(e.code));

    const built = await mapLimit(entries, 2, buildEntry);

    const ok = built.filter(Boolean);
    const articleName = articleArchetype(article.archetypeJp, ok.map((b) => b.cards));
    // ¿el título del artículo nombra un Pokémon del mazo? (si no, es un apodo: ver scraper/index.js)
    const titleHits = ok.filter((b) => translateArchetype(article.archetypeJp, b.cards).matched).length;
    const titleMatched = ok.length > 0 && titleHits >= ok.length / 2;
    for (const b of ok) {
      const archetype = articleName ?? translateArchetype(article.archetypeJp, b.cards).name;
      decks.push({
        id: `pcb-${b.entry.code}`,
        source: 'pokecabook',
        format: 'japan',
        archetype,
        archetypeJp: article.archetypeJp,
        titleMatched,
        archetypeId: `pcb-${slug(archetype)}`,
        archetypeShare: null,
        icons: [],
        title: archetype,
        player: null,
        placement: b.entry.placement,
        event: stripPlacement(b.entry.caption) || 'City League / Gym Battle',
        environment: b.entry.environment,
        date: b.entry.date,
        url: `https://www.pokemon-card.com/deck/confirm.html/deckID/${b.entry.code}`,
        articleUrl: article.url,
        preview: b.entry.preview,
        cards: b.cards,
      });
    }
    await saveTranslations();
    log(`[pokecabook] (${i + 1}/${articles.length}) ${article.archetypeJp}: ${built.filter(Boolean).length} mazos`);
  }
  // Recopilaciones diarias de Gym Battle: cada mazo con su propio arquetipo (h4)
  const maxDaily = Number(process.env.POKECABOOK_DAILY_MAX ?? 80);
  for (const id of DAILY_IDS) {
    let daily;
    try {
      daily = await getDailyDecks(id);
    } catch (e) {
      log(`[pokecabook]  ✗ recopilación ${id}: ${e.message}`);
      continue;
    }
    const entries = daily.entries.filter((e) => !seenCodes.has(e.code)).slice(0, maxDaily);
    entries.forEach((e) => seenCodes.add(e.code));
    const built = (await mapLimit(entries, 2, buildEntry)).filter(Boolean);
    for (const b of built) {
      const tr = translateArchetype(b.entry.archetypeJp, b.cards);
      decks.push({
        id: `pcb-${b.entry.code}`,
        source: 'pokecabook',
        format: 'japan',
        archetype: tr.name,
        archetypeJp: b.entry.archetypeJp,
        titleMatched: tr.matched,
        archetypeId: `pcb-${slug(tr.name)}`,
        archetypeShare: null,
        icons: [],
        title: tr.name,
        player: null,
        placement: b.entry.placement,
        event: stripPlacement(b.entry.caption) || 'Gym Battle',
        environment: null,
        date: b.entry.date,
        url: `https://www.pokemon-card.com/deck/confirm.html/deckID/${b.entry.code}`,
        articleUrl: daily.url,
        preview: b.entry.preview,
        cards: b.cards,
      });
    }
    await saveTranslations();
    log(`[pokecabook] recopilación diaria ${id}: ${built.length} mazos nuevos (de ${daily.entries.length})`);
  }

  await saveTranslations();
  const fixed = fillMissingTranslations(decks);
  const missing = new Set(decks.flatMap((d) => d.cards.filter((c) => !c.translated).map((c) => c.jpName)));
  log(`[pokecabook] traducciones completadas por nombre: ${fixed}; sin traducir: ${missing.size}${missing.size ? ' (' + [...missing].join(', ') + ')' : ''}`);
  return decks;
}
