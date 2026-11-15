// Scraper de https://limitlesstcg.com/tournaments/jp (City League de Japón, listas ya traducidas al inglés)
// 1) índice de torneos (paginado) hasta cubrir los últimos N días
// 2) en cada torneo, las listas del top N con puesto y jugador
// 3) cada lista -> cartas (impresiones en inglés cuando existen)
import * as cheerio from 'cheerio';
import { getText, mapLimit } from './http.js';
import { getArchetypes, getDecklist } from './limitless.js';
import { normName } from '../public/cardkey.js';

const BASE = 'https://limitlesstcg.com';

const slugOfIcon = (src) => src.match(/\/([a-z0-9-]+)\.png$/i)?.[1] ?? null;
const iconKey = (slugs) => [...slugs].sort().join('+');

async function getTournaments({ days, maxPages }) {
  const out = [];
  let newest = null;
  for (let page = 1; page <= maxPages; page++) {
    const html = await getText(`${BASE}/tournaments/jp${page > 1 ? `?page=${page}` : ''}`, { ttlHours: 6 });
    const $ = cheerio.load(html);
    const rows = $('table.completed-tournaments tr[data-date]').toArray();
    if (!rows.length) break;
    let reachedLimit = false;
    for (const tr of rows) {
      const date = $(tr).attr('data-date');
      const href = $(tr).find('a[href*="/tournaments/jp/"]').attr('href');
      const id = href?.match(/\/tournaments\/jp\/(\d+)/)?.[1];
      if (!id || !date) continue;
      newest ??= date;
      if ((new Date(newest) - new Date(date)) / 86400_000 > days) {
        reachedLimit = true;
        break;
      }
      if (!out.some((t) => t.id === id)) out.push({ id, date, city: $(tr).attr('data-city') ?? null, shop: $(tr).attr('data-shop') ?? null });
    }
    if (reachedLimit) break;
  }
  return out;
}

async function getTournamentTop(t, top) {
  const html = await getText(`${BASE}/tournaments/jp/${t.id}`, { ttlHours: 24 * 7 });
  const $ = cheerio.load(html);
  const title = $('title').text().replace(/\s*–\s*Limitless\s*$/, '').trim();
  const entries = [];
  $('table.data-table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const place = Number($(tds[0]).text().trim());
    const listId = $(tr).find('a[href*="/decks/list/jp/"]').attr('href')?.match(/\/decks\/list\/jp\/(\d+)/)?.[1];
    if (!place || !listId || place > top) return;
    entries.push({
      place,
      listId,
      player: $(tds[1]).text().trim() || null,
      icons: $(tr).find('img.pokemon').map((_, img) => $(img).attr('src')).get(),
    });
  });
  return { title, entries };
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`;

/** Nombre del arquetipo a partir de los íconos: el de Limitless si coinciden, si no, desde las cartas. */
function nameFromIcons(icons, cards, archetypeByIcons) {
  const slugs = icons.map(slugOfIcon).filter(Boolean);
  const pokemon = cards.filter((c) => c.section === 'pokemon');
  // nombre de Limitless sólo si su Pokémon principal está en el mazo (evita arquetipos con el mismo ícono)
  const known = archetypeByIcons.get(iconKey(slugs));
  const inDeck = (name) =>
    pokemon.some((c) => {
      const base = normName(c.name).replace(/ ex$/, '');
      return base.length >= 4 && normName(name).includes(base);
    });
  if (known && inDeck(known)) return known;
  const names = slugs.map((slug) => {
    const isMega = slug.endsWith('-mega');
    const base = slug.replace(/-mega$/, '');
    const plain = (c) => normName(c.name).replace(/^mega /, '').replace(/ ex$/, '').replace(/[^a-z0-9]+/g, '-');
    const cands = pokemon.filter((c) => {
      const p = plain(c);
      return (p === base || p.endsWith('-' + base)) && (!isMega || /^mega /i.test(c.name));
    });
    const best = cands.sort((a, b) => Number(/ ex$/.test(b.name)) - Number(/ ex$/.test(a.name)) || b.count - a.count)[0];
    return best?.name ?? base.replace(/(^|-)([a-z])/g, (_, s, ch) => (s ? ' ' : '') + ch.toUpperCase());
  });
  return [...new Set(names)].join(' / ') || 'Otros';
}

export async function scrapeLimitlessJp({
  days = Number(process.env.LIMITLESS_JP_DAYS ?? 14),
  top = Number(process.env.LIMITLESS_JP_TOP ?? 8),
  maxPages = Number(process.env.LIMITLESS_JP_PAGES ?? 12),
  log = console.log,
} = {}) {
  // íconos -> nombre de arquetipo de Limitless (se usa la tabla completa, no sólo el top)
  const archetypeByIcons = new Map();
  const archetypeIcons = new Map();
  const current = (await getArchetypes()).slice(0, Number(process.env.LIMITLESS_ARCHETYPES ?? 30));
  for (const a of current) {
    const k = iconKey(a.icons.map(slugOfIcon).filter(Boolean));
    if (k && !archetypeByIcons.has(k)) {
      archetypeByIcons.set(k, a.name);
      archetypeIcons.set(a.name, a.icons);
    }
  }

  const tournaments = await getTournaments({ days, maxPages });
  log(`[limitless-jp] ${tournaments.length} torneos (últimos ${days} días, top ${top})`);
  const decks = [];

  for (const [i, t] of tournaments.entries()) {
    let info;
    try {
      info = await getTournamentTop(t, top);
    } catch (e) {
      log(`[limitless-jp]  ✗ torneo ${t.id}: ${e.message}`);
      continue;
    }
    const lists = await mapLimit(info.entries, 2, async (e) => {
      try {
        return { e, list: await getDecklist(`jp/${e.listId}`) };
      } catch (err) {
        log(`[limitless-jp]  ✗ lista ${e.listId}: ${err.message}`);
        return null;
      }
    });
    for (const r of lists.filter(Boolean)) {
      const archetype = nameFromIcons(r.e.icons, r.list.cards, archetypeByIcons);
      decks.push({
        // la misma lista puede repetirse en varios torneos: el id incluye el torneo
        id: `ljp-${t.id}-${r.e.listId}`,
        source: 'limitless-jp',
        format: 'japan',
        archetype,
        archetypeId: `ljp-${iconKey(r.e.icons.map(slugOfIcon).filter(Boolean))}`,
        archetypeShare: null,
        icons: r.e.icons.length ? r.e.icons : archetypeIcons.get(archetype) ?? [],
        title: archetype,
        player: r.e.player,
        placement: ordinal(r.e.place),
        event: info.title || `City League ${t.city ?? ''}`.trim(),
        shop: t.shop,
        date: t.date,
        url: `${BASE}/decks/list/jp/${r.e.listId}`,
        tournamentUrl: `${BASE}/tournaments/jp/${t.id}`,
        cards: r.list.cards,
      });
    }
    if ((i + 1) % 10 === 0 || i === tournaments.length - 1) log(`[limitless-jp] (${i + 1}/${tournaments.length}) torneos procesados, ${decks.length} listas`);
  }

  // Mismos íconos = mismo arquetipo: un solo nombre (el más frecuente), sin importar el orden
  // de los íconos ni si se eligió la versión ex o la normal de una carta.
  const byIcons = new Map();
  for (const d of decks) {
    if (!byIcons.has(d.archetypeId)) byIcons.set(d.archetypeId, []);
    byIcons.get(d.archetypeId).push(d);
  }
  for (const group of byIcons.values()) {
    const counts = new Map();
    for (const d of group) counts.set(d.archetype, (counts.get(d.archetype) ?? 0) + 1);
    const name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const d of group) d.archetype = d.title = name;
  }
  return decks;
}
