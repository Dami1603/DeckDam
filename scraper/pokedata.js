// Scraper de https://www.pokedata.ovh/standings (torneos oficiales Play! Pokémon con listas de casi todos los jugadores)
// 1) índice de torneos TCG  2) fecha de cada torneo (página de Masters)
// 3) JSON de standings de Masters: puesto, récord y lista de cada jugador -> top N
// El JSON no trae nombre de arquetipo: se asigna después en scraper/classify.js.
import * as cheerio from 'cheerio';
import { getText } from './http.js';
import { limitlessImage } from './limitless.js';

const BASE = 'https://www.pokedata.ovh/standings';

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** "September 18-20, 2026" / "May 30-June 1, 2026" -> "2026-09-18" (primer día) */
function parseEventDate(text) {
  const m = text.match(/([A-Z][a-z]+)\s+(\d{1,2})[^,]*,\s*(\d{4})/);
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Quita los sufijos de pokedata: "Hero's Cape - ACESPEC", "Psychic Energy - Basic", "Jet Energy - Special" */
const cleanName = (name) => name.replace(/\s+-\s+(ACESPEC|Basic|Special)$/i, '').trim();

async function getEventIndex() {
  const html = await getText(`${BASE}/`, { ttlHours: 12 });
  const $ = cheerio.load(html);
  const events = [];
  $('button[onclick]').each((_, b) => {
    const id = $(b).attr('onclick').match(/location\.href='(\d+)\/'/)?.[1];
    // el botón trae "Nombre del torneo\n - September 18-20, 2026": sólo el nombre
    const name = $(b).text().split('\n')[0].replace(/\s+-\s*$/, '').trim();
    if (id && name && !events.some((e) => e.id === id)) events.push({ id, name });
  });
  return events.sort((a, b) => Number(b.id) - Number(a.id)); // más recientes primero
}

async function getEventDate(id) {
  const html = await getText(`${BASE}/${id}/masters/`, { ttlHours: 24 * 30 });
  return parseEventDate(cheerio.load(html)('body').text().replace(/\s+/g, ' '));
}

const SECTIONS = { pokemon: 'pokemon', trainer: 'trainer', energy: 'energy' };

function toCards(decklist) {
  const cards = [];
  for (const [key, section] of Object.entries(SECTIONS)) {
    for (const c of decklist[key] ?? []) {
      const set = c.set || null;
      const number = c.number ? String(c.number) : null;
      cards.push({
        name: cleanName(c.name),
        count: Number(c.count) || 1,
        section,
        set,
        number,
        lang: 'en',
        image: limitlessImage(set, number, 'en'),
      });
    }
  }
  return cards;
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`;

/**
 * @param {{since: string, top?: number, maxEvents?: number}} opts since = fecha ISO desde la que se toman torneos
 */
export async function scrapePokedata({
  since,
  top = Number(process.env.POKEDATA_TOP ?? 64),
  maxEvents = Number(process.env.POKEDATA_EVENTS ?? 12),
  log = console.log,
} = {}) {
  const index = await getEventIndex();
  const decks = [];
  let used = 0;

  for (const ev of index) {
    if (used >= maxEvents) break;
    const date = await getEventDate(ev.id).catch(() => null);
    if (!date) continue;
    if (date < since) break; // el índice está ordenado: lo que sigue es más viejo

    // los torneos recientes publican las listas días después: se revisan más seguido
    const ageDays = (Date.now() - new Date(date)) / 86400_000;
    let players;
    try {
      const raw = await getText(`${BASE}/${ev.id}/masters/${ev.id}_Masters.json`, { ttlHours: ageDays < 60 ? 12 : Infinity });
      players = JSON.parse(raw);
    } catch (e) {
      log(`[pokedata]  ✗ ${ev.name}: ${e.message}`);
      continue;
    }
    const withList = players
      .filter((p) => p.decklist && typeof p.decklist === 'object' && Object.keys(p.decklist).length)
      .sort((a, b) => a.placing - b.placing);
    if (!withList.length) {
      log(`[pokedata]  · ${ev.name} (${date}): todavía sin listas publicadas`);
      continue;
    }
    used++;
    for (const p of withList.slice(0, top)) {
      const r = p.record ?? {};
      decks.push({
        id: `pd-${ev.id}-${p.placing}`,
        source: 'pokedata',
        format: 'standard',
        archetype: null, // se clasifica en scraper/classify.js
        archetypeId: null,
        archetypeShare: null,
        icons: [],
        title: null,
        player: p.name ?? null,
        placement: ordinal(p.placing),
        record: `${r.wins ?? 0}-${r.losses ?? 0}-${r.ties ?? 0}`,
        event: ev.name.replace(/^\d{4}\s+/, '').replace(/Pokémon TCG /, ''),
        date,
        url: `${BASE}/${ev.id}/masters/`,
        cards: toCards(p.decklist),
      });
    }
    log(`[pokedata] ${ev.name} (${date}): ${Math.min(top, withList.length)} de ${withList.length} listas`);
  }
  return decks;
}
