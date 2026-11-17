// Scraper for https://pokecabook.com (Japanese meta decks)
// 1) archetype indexes, in order: https://pokecabook.com/archives/1417 (main meta,
//    "環境デッキレシピまとめ") and https://pokecabook.com/archives/6132 (other archetypes, "その他")
// 2) in each archetype article, the figures linking to an official deck code (pokemon-card.com),
//    only from the current-format section (e.g. "30th CELEBRATION環境")
// 3) each deck code -> cards (official JP IDs) -> English translation
// Also the daily Gym Battle winners compilation (https://pokecabook.com/archives/27265), where each
// deck has a subtitle (h4) with its archetype on top: decks with new cards show up there first.
import * as cheerio from 'cheerio';
import { getText, mapLimit } from './http.js';
import { translateCard, saveTranslations } from './translate.js';
import { limitlessImage } from './limitless.js';

const BASE = 'https://pokecabook.com';
const DECK_RE = /pokemon-card\.com\/deck\/(?:confirm|result)\.html\/deckID\/([A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+)/;

const SECTION_BY_FIELD = {
  deck_pke: 'pokemon',
  deck_gds: 'trainer', // items
  deck_tool: 'trainer', // herramientas
  deck_tech: 'trainer', // technical machines
  deck_sup: 'trainer', // partidarios
  deck_sta: 'trainer', // estadios
  deck_ajs: 'trainer', // ACE SPEC
  deck_ene: 'energy',
};

// Archetype indexes (article ids), in order: main meta and then "others"
const HUB_IDS = (process.env.POKECABOOK_HUBS ?? '1417,6132').split(',').map((s) => s.trim()).filter(Boolean);
const HUB_URLS = HUB_IDS.map((id) => `${BASE}/archives/${id}`);

/** Archetypes from the Pokecabook indexes, in the order they appear (no repeats). */
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
      // only links with an archetype name (banners without text are other sections of the site);
      // the indexes themselves are not deck articles
      if (!id || !name || HUB_IDS.includes(id) || articles.some((x) => x.id === id)) return;
      articles.push({ id, url: `${BASE}/archives/${id}`, title: name, archetypeJp: name, hub: HUB_IDS[i] });
    });
  }
  return articles.slice(0, maxArticles);
}

// Daily compilations (mixed decks, each with its archetype in an h4)
const DAILY_IDS = (process.env.POKECABOOK_DAILY ?? '27265').split(',').map((s) => s.trim()).filter(Boolean);

async function getDailyDecks(id) {
  const url = `${BASE}/archives/${id}`;
  const html = await getText(url, { ttlHours: 6 });
  const $ = cheerio.load(html);
  const published =
    $('meta[property="article:modified_time"]').attr('content') ?? html.match(/"dateModified":"([^"]+)"/)?.[1] ?? null;
  const refDate = published ? new Date(published) : new Date();
  const entries = [];
  let section = null; // h2/h3: date of the day ("11/14【土】ジムバトル優勝")
  let name = null; // h4: archetype of the next deck
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
  if (month > ref.getMonth() + 1 + 1) year -= 1; // December seen in January, etc.
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
  if (!cards.length) throw new Error(`empty or invalid deck ${code}`);
  return cards;
}

const stripEx = (s) => s.replace(/\s+/g, '').replace(/ex$/i, '').replace(/^メガ/, '');

/**
 * Translates the archetype name (e.g. "ハンマードラパルト(ノココッチ)") using the deck's cards.
 * matched=false when the title is a nickname with no recognizable Pokémon (the main Pokémon is used).
 */
function translateArchetype(archetypeJp, cards) {
  const pokemon = cards.filter((c) => c.section === 'pokemon' && c.name);
  const tokens = archetypeJp.split(/[＋+()（）・/／]/).map((t) => t.replace(/\s+/g, '')).filter(Boolean);
  const matched = [];
  const compact = (s) => s.replace(/\s+/g, '');
  for (const token of tokens) {
    // score: exact match > same Mega form > same "ex" > longer name.
    // (メガヤンマ is the Japanese name of Yanmega, not a Mega: the exact match resolves it)
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
 * A single name for all decks of an article, or null to name each deck separately.
 * - Title with a Pokémon recognized in most lists: the most frequent name.
 * - Set title ("30th CELEBRATION"): mixed decks, null.
 * - Nickname ("アビスアイ"): the Pokémon present in almost every list with the most copies (prefers ex/Mega).
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

/** Fills untranslated cards with the translation of another print with the same Japanese name. */
// Cards Limitless does not have in its Japanese database
// Cards with no English translation on the Japanese card sheets (mostly Black & White / XY prints played in Expanded)
const MANUAL_TRANSLATIONS = [
  ['スクランブルスイッチ', 'Scramble Switch'],
  ['じてんしゃ', 'Bicycle'],
  ['ダウジングマシン', 'Dowsing Machine'],
  ['アクロマ', 'Colress'],
  ['ポケギア3.0', 'Pokégear 3.0'],
  ['ロケット団の工作', "Team Rocket's Handiwork"],
  ['タチワキシティジム', 'Virbank City Gym'],
  ['ホウオウEX', 'Ho-Oh-EX'],
  ['アンノーン', 'Unown'],
  ['欲張りダイス', 'Greedy Dice'],
  ['タマタマ', 'Exeggcute'],
  ['ミロカロス', 'Milotic'],
  ['退化スプレー', 'Devolution Spray'],
  ['ミカルゲ', 'Spiritomb'],
  ['ラフレシア', 'Vileplume'],
  ['ラクライ', 'Electrike'],
  ['トロピカルビーチ', 'Tropical Beach'],
  ['マーイーカ', 'Inkay'],
  ['エリートトレーナー', 'Ace Trainer'],
  ['アオギリの切り札', "Archie's Ace in the Hole"],
  ['ジバコイル', 'Magnezone'],
  ['いのちのしずく', 'Life Dew'],
];

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
  log(`[pokecabook] ${articles.length} archetypes in the indexes (${HUB_URLS.join(', ')})`);

  // 1) decks of each article, with their format section
  const perArticle = new Map();
  for (const article of articles) {
    try {
      perArticle.set(article.id, await getArticleDecks(article));
    } catch (e) {
      log(`[pokecabook]  ✗ ${article.title}: ${e.message}`);
    }
  }

  // 2) current format = the most common first section with decks across articles (or POKECABOOK_ENV)
  const firstEnvs = [...perArticle.values()].map((list) => list.find((e) => e.environment)?.environment).filter(Boolean);
  const envCount = new Map();
  for (const e of firstEnvs) envCount.set(e, (envCount.get(e) ?? 0) + 1);
  const currentEnv = process.env.POKECABOOK_ENV ?? [...envCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  log(`[pokecabook] current format: ${currentEnv ?? '(no sections)'}`);

  const decks = [];
  const seenCodes = new Set(); // the same deck can appear in two articles (e.g. Dragapult and Hammer Dragapult)

  /** Official code -> translated cards (or null on failure). */
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
      log(`[pokecabook]  ✗ deck ${entry.code}: ${e.message}`);
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
    // does the article title name a Pokémon in the deck? (if not, it is a nickname: see scraper/index.js)
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
    log(`[pokecabook] (${i + 1}/${articles.length}) ${article.archetypeJp}: ${built.filter(Boolean).length} decks`);
  }
  // Daily Gym Battle compilations: each deck with its own archetype (h4)
  const maxDaily = Number(process.env.POKECABOOK_DAILY_MAX ?? 80);
  for (const id of DAILY_IDS) {
    let daily;
    try {
      daily = await getDailyDecks(id);
    } catch (e) {
      log(`[pokecabook]  ✗ compilation ${id}: ${e.message}`);
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
    log(`[pokecabook] daily compilation ${id}: ${built.length} new decks (of ${daily.entries.length})`);
  }

  await saveTranslations();
  const fixed = fillMissingTranslations(decks);
  const missing = new Set(decks.flatMap((d) => d.cards.filter((c) => !c.translated).map((c) => c.jpName)));
  log(`[pokecabook] translations completed by name: ${fixed}; untranslated: ${missing.size}${missing.size ? ' (' + [...missing].join(', ') + ')' : ''}`);
  return decks;
}

// ---------------------------------------------------------------- Expanded ("エクストラ")
// Winner decks of the official "Extra Battle Day" events: https://pokecabook.com/archives/category/tournament/extra
// Each article covers a format period; inside, an h2 per archetype followed by its official deck codes.
const EXPANDED_CATEGORY = `${BASE}/archives/category/tournament/extra`;

async function getExpandedArticles(max) {
  const html = await getText(EXPANDED_CATEGORY, { ttlHours: 12 });
  const $ = cheerio.load(html);
  const out = [];
  $('a.entry-card-wrap').each((_, a) => {
    const href = $(a).attr('href');
    const id = href?.match(/\/archives\/(\d+)/)?.[1];
    if (!id || out.some((x) => x.id === id)) return;
    out.push({ id, url: `${BASE}/archives/${id}`, title: $(a).attr('title') ?? '' });
  });
  return out.slice(0, max);
}

async function getExpandedArticleDecks(article) {
  const html = await getText(article.url, { ttlHours: 6 });
  const $ = cheerio.load(html);
  const modified = $('meta[property="article:modified_time"]').attr('content') ?? html.match(/"dateModified":"([^"]+)"/)?.[1] ?? null;
  const entries = [];
  let heading = null;
  $('.entry-content')
    .find('h2, h3, figure')
    .each((_, el) => {
      if (el.tagName !== 'figure') {
        heading = $(el).text().replace(/\s+/g, ' ').trim();
        return;
      }
      const m = $(el).find('a[href*="pokemon-card.com/deck/"]').attr('href')?.match(DECK_RE);
      if (!m || !heading || entries.some((e) => e.code === m[1])) return;
      entries.push({ code: m[1], archetypeJp: heading, preview: $(el).find('img').attr('src') ?? null });
    });
  return { entries, date: modified ? modified.slice(0, 10) : null };
}

/** Code -> translated cards (same as the Standard flow). */
async function expandedDeckCards(code) {
  const raw = await getOfficialDeck(code);
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
  return cards;
}

export async function scrapePokecabookExpanded({
  maxArticles = Number(process.env.POKECABOOK_EXPANDED_ARTICLES ?? 2),
  decksPerArchetype = Number(process.env.POKECABOOK_EXPANDED_DECKS ?? 8),
  log = console.log,
} = {}) {
  const articles = await getExpandedArticles(maxArticles);
  log(`[pokecabook-expanded] ${articles.length} articles (${EXPANDED_CATEGORY})`);
  const decks = [];
  const seen = new Set();
  for (const article of articles) {
    let data;
    try {
      data = await getExpandedArticleDecks(article);
    } catch (e) {
      log(`[pokecabook-expanded]  ✗ ${article.title}: ${e.message}`);
      continue;
    }
    // group by archetype heading, keeping the first N decks of each
    const groups = new Map();
    for (const e of data.entries) {
      if (seen.has(e.code)) continue;
      if (!groups.has(e.archetypeJp)) groups.set(e.archetypeJp, []);
      if (groups.get(e.archetypeJp).length < decksPerArchetype) groups.get(e.archetypeJp).push(e);
    }
    const isCL = /チャンピオンズリーグ|【CL】/.test(article.title);
    const environment = article.title.match(/【([^】]*環境)】/)?.[1] ?? null;
    let count = 0;
    for (const [archetypeJp, entries] of groups) {
      entries.forEach((e) => seen.add(e.code));
      const built = (
        await mapLimit(entries, 2, async (e) => {
          try {
            return { e, cards: await expandedDeckCards(e.code) };
          } catch (err) {
            log(`[pokecabook-expanded]  ✗ deck ${e.code}: ${err.message}`);
            return null;
          }
        })
      ).filter(Boolean);
      if (!built.length) continue;
      const shared = articleArchetype(archetypeJp, built.map((b) => b.cards));
      for (const b of built) {
        const archetype = shared ?? translateArchetype(archetypeJp, b.cards).name;
        decks.push({
          id: `pcbx-${b.e.code}`,
          source: 'pokecabook-expanded',
          format: 'expanded',
          archetype,
          archetypeJp,
          archetypeId: `pcbx-${slug(archetype)}`,
          archetypeShare: null,
          icons: [],
          title: archetype,
          player: null,
          placement: isCL ? null : '1st',
          event: isCL ? 'Champions League (Expanded)' : 'Expanded Battle Day',
          environment,
          date: data.date,
          url: `https://www.pokemon-card.com/deck/confirm.html/deckID/${b.e.code}`,
          articleUrl: article.url,
          preview: b.e.preview,
          cards: b.cards,
        });
        count++;
      }
      await saveTranslations();
    }
    log(`[pokecabook-expanded] ${article.title}: ${count} decks`);
  }
  await saveTranslations();
  fillMissingTranslations(decks);
  // archetypes named after a card that was only translated afterwards (e.g. "ラフレシア" -> "Vileplume")
  const manual = new Map(MANUAL_TRANSLATIONS);
  for (const d of decks) {
    const en = manual.get(d.archetype);
    if (!en) continue;
    d.archetype = d.title = en;
    d.archetypeId = `pcbx-${slug(en)}`;
  }
  return decks;
}
