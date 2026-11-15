// Scraper de https://limitlesstcg.com/decks
// 1) Lista de arquetipos del formato  2) listas recientes de cada arquetipo  3) cartas de cada lista
import * as cheerio from 'cheerio';
import { getText, mapLimit } from './http.js';

const BASE = 'https://limitlesstcg.com';

export function limitlessImage(set, number, lang = 'en', size = 'SM') {
  if (!set || !number) return null;
  if (lang === 'jp') {
    if (/^[A-Za-z]+-P$/.test(set)) set = set.replace('-', '');
    return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpc/${set}/${set}_${Number(number)}_R_JP_${size}.png`;
  }
  const n = /^\d+$/.test(number) ? String(number).padStart(3, '0') : number;
  return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${set}/${set}_${n}_R_EN_${size}.png`;
}

// Sin parámetro de formato, Limitless muestra el formato vigente (desde la última rotación).
// Ojo: "?format=standard" es el histórico de Standard de todas las épocas, no el meta actual.
const fmtQuery = (format) => (format ? `?format=${format}` : '');

export async function getArchetypes(format = null) {
  const html = await getText(`${BASE}/decks${fmtQuery(format)}`, { ttlHours: 12 });
  const $ = cheerio.load(html);
  const list = [];
  $('table.data-table tr').each((_, tr) => {
    const a = $(tr).find('a[href^="/decks/"]').first();
    const m = a.attr('href')?.match(/^\/decks\/(\d+)/);
    if (!m) return;
    const tds = $(tr).find('td');
    const annotation = a.find('.annotation').text().trim();
    const base = a.clone().children().remove().end().text().trim();
    list.push({
      id: m[1],
      name: [base, annotation].filter(Boolean).join(' '),
      icons: $(tr).find('img.pokemon').map((_, img) => $(img).attr('src')).get(),
      points: Number($(tds[3]).text().trim()) || null,
      share: $(tds[4]).text().trim() || null,
    });
  });
  return list;
}

async function getArchetypeLists(archetypeId, format, max) {
  const html = await getText(`${BASE}/decks/${archetypeId}${fmtQuery(format)}`, { ttlHours: 12 });
  const $ = cheerio.load(html);
  const ids = [];
  $('a[href^="/decks/list/"]').each((_, a) => {
    const m = $(a).attr('href').match(/\/decks\/list\/(\d+)/);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  });
  return ids.slice(0, max);
}

function sectionFromHeading(h) {
  if (/pok/i.test(h)) return 'pokemon';
  if (/trainer/i.test(h)) return 'trainer';
  return 'energy';
}

/** @param {string} listPath id de lista ("31128") o ruta japonesa ("jp/76883") */
export async function getDecklist(listPath) {
  // las listas publicadas no cambian: caché permanente
  const html = await getText(`${BASE}/decks/list/${listPath}`, { ttlHours: Infinity });
  const $ = cheerio.load(html);
  const desc = $('meta[name="description"]').attr('content') ?? '';
  // "Raging Bolt Ogerpon decklist by Kacper Dolny - 86th Place Regional Gdańsk - 31st October 2026"
  const m = desc.match(/^(.*?) decklist by (.*?) - (\S+) Place (.*) - (.*)$/);
  const title = $('.decklist-title').first().clone().children().remove().end().text().trim();

  const cards = [];
  $('.decklist-column').each((_, col) => {
    const section = sectionFromHeading($(col).find('.decklist-column-heading').text());
    $(col)
      .find('.decklist-card')
      .each((_, el) => {
        const $el = $(el);
        const set = $el.attr('data-set') || null;
        const number = $el.attr('data-number') || null;
        const lang = $el.attr('data-lang') || 'en';
        cards.push({
          name: $el.find('.card-name').text().trim(),
          count: Number($el.find('.card-count').text().trim()) || 1,
          section,
          set,
          number,
          lang,
          image: limitlessImage(set, number, lang),
        });
      });
  });

  return {
    title: title || m?.[1] || 'Decklist',
    player: m?.[2] ?? null,
    placement: m?.[3] ?? null,
    event: m?.[4] ?? null,
    date: m?.[5] ? toIsoDate(m[5]) : null,
    cards,
  };
}

function toIsoDate(s) {
  const d = new Date(s.replace(/(\d+)(st|nd|rd|th)/, '$1') + ' UTC');
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

export async function scrapeLimitless({
  format = null,
  maxArchetypes = Number(process.env.LIMITLESS_ARCHETYPES ?? 30),
  listsPerArchetype = Number(process.env.LIMITLESS_LISTS ?? 6),
  log = console.log,
} = {}) {
  const archetypes = (await getArchetypes(format)).slice(0, maxArchetypes);
  log(`[limitless] ${archetypes.length} arquetipos (${format ?? 'formato vigente'})`);
  const decks = [];

  for (const [i, arch] of archetypes.entries()) {
    let ids = [];
    try {
      ids = await getArchetypeLists(arch.id, format, listsPerArchetype);
    } catch (e) {
      log(`[limitless]  ✗ ${arch.name}: ${e.message}`);
      continue;
    }
    const lists = await mapLimit(ids, 2, async (listId) => {
      try {
        return { listId, ...(await getDecklist(listId)) };
      } catch (e) {
        log(`[limitless]  ✗ lista ${listId}: ${e.message}`);
        return null;
      }
    });
    for (const l of lists.filter(Boolean)) {
      decks.push({
        id: `lim-${l.listId}`,
        source: 'limitless',
        format: format ?? 'standard',
        archetype: arch.name,
        archetypeId: `lim-${arch.id}`,
        archetypeShare: arch.share,
        icons: arch.icons,
        title: l.title,
        player: l.player,
        placement: l.placement,
        event: l.event,
        date: l.date,
        url: `${BASE}/decks/list/${l.listId}`,
        cards: l.cards,
      });
    }
    log(`[limitless] (${i + 1}/${archetypes.length}) ${arch.name}: ${lists.filter(Boolean).length} listas`);
  }
  return decks;
}
