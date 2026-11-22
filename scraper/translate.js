// Translation of Japanese cards (pokemon-card.com) to English.
// Path: official JP id -> (set code, number) -> limitlesstcg.com/cards/jp/SET/N?translate=en
// Result cached forever in data/jp-translations.json
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { getText } from './http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'jp-translations.json');

// Basic Energy: same name Limitless uses in its lists ("Psychic Energy")
// and reference print in Mega Evolution Energy (MEE).
const BASIC_ENERGY = {
  草: ['Grass', 9], 炎: ['Fire', 10], 水: ['Water', 11], 雷: ['Lightning', 12], 超: ['Psychic', 13],
  闘: ['Fighting', 14], 悪: ['Darkness', 15], 鋼: ['Metal', 16], フェアリー: ['Fairy', null],
};

// Generic era logos ("XY", "BW"...) printed on old deck/kit cards instead of the expansion code.
// Limitless has real sets with some of those codes (e.g. "XY" = Best of XY), so looking them up by
// number returns an unrelated card ("Special Charge" read as "Seismitoad-EX").
const ERA_LOGOS = new Set(['XY', 'BW', 'SM', 'DP', 'DPt', 'PT', 'HS', 'L', 'LL', 'PCG', 'ADV']);

// Black & White / XY expansions: official "XY6-B" / "XY8-Bb" / "BW6-Bc" -> Limitless "XY6" / "XY8b" / "BW6c"
const OLD_CODE = /^(BW|XY)(\d+)-B(\w*)$/;

// results cached before the era / old-code handling existed: retried
const isStale = (r) => Boolean(r?.set) && !r.v && (ERA_LOGOS.has(r.set) || OLD_CODE.test(r.set));

let cache = null;
let dirty = 0;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    cache = {};
  }
  for (const [id, r] of Object.entries(cache)) {
    if (isStale(r)) {
      delete cache[id];
      dirty++;
    }
  }
  return cache;
}

export async function saveTranslations() {
  if (!cache || !dirty) return;
  await writeFile(FILE, JSON.stringify(cache, null, 1), 'utf8');
  dirty = 0;
}

/** "メガガルーラex(M1S 051/063)" -> { set: 'M1S', number: '51' } */
export function parseSetFromName(name) {
  const m = name.match(/\(([A-Za-z0-9-]+)\s+(\d+)\/[0-9A-Za-z-]+\)\s*$/);
  return m ? { set: m[1], number: String(Number(m[2])) } : null;
}

async function setFromOfficialDetails(cardId) {
  const html = await getText(
    `https://www.pokemon-card.com/card-search/details.php/card/${cardId}/regu/all`,
    { ttlHours: Infinity },
  );
  const $ = cheerio.load(html);
  const set = $('img.img-regulation').attr('alt')?.trim();
  const numMatch = html.match(/(\d{1,3})&nbsp;\/&nbsp;[0-9A-Za-z-]+/);
  if (!set || !numMatch || ERA_LOGOS.has(set)) return null;
  return { set, number: String(Number(numMatch[1])) };
}

/** Limitless codes to try for an official set code, most likely first. */
function limitlessSetCodes(set) {
  // Promos: the official code has a hyphen ("SV-P", "M-P") and the Limitless one does not ("SVP", "MP")
  if (/^[A-Za-z]+-P$/.test(set)) return [set.replace('-', '')];
  const m = set.match(OLD_CODE);
  if (!m) return [set];
  const sub = m[3].toLowerCase();
  return [...new Set([`${m[1]}${m[2]}${sub}`, `${m[1]}${m[2]}${sub.slice(0, 1)}`])];
}

/** "Pokémon - Basic" / "Trainer - Item" / "Energy - Special Energy" -> section of a deck list */
function sectionOfType(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (t.startsWith('pok')) return 'pokemon';
  if (t.startsWith('trainer')) return 'trainer';
  if (t.startsWith('energy')) return 'energy';
  return null;
}

async function limitlessJpPage(rawSet, number) {
  let lastErr;
  for (const set of limitlessSetCodes(rawSet)) {
    try {
      return { set, html: await getText(`https://limitlesstcg.com/cards/jp/${encodeURIComponent(set)}/${number}?translate=en`, { ttlHours: Infinity }) };
    } catch (e) {
      lastErr = e;
      if (!/HTTP 404/.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

async function englishNameFromLimitless(rawSet, number) {
  const { set, html } = await limitlessJpPage(rawSet, number);
  const $ = cheerio.load(html);
  const literal = $('.card-text-name').first().text().trim() || null;
  const jpCategory = sectionOfType($('.card-text-type').first().text());

  // International prints (chronological order): the most recent gives the official
  // English name (the literal translation may differ, e.g. "Boss's Command" vs "Boss's Orders")
  const section = html.split('Int. Prints')[1]?.split('JP. Prints')[0] ?? '';
  const prints = [...section.matchAll(/href="\/cards\/en\/([A-Za-z0-9-]+)\/(\w+)"/g)];
  if (!prints.length) return { set, name: literal, intl: null, category: jpCategory };
  // from the most recent set, the lowest-numbered print (regular version, not the secret/gold rare)
  const lastSet = prints.at(-1)[1];
  const num = (n) => (/^\d+$/.test(n) ? Number(n) : Infinity);
  const pick = prints.filter((p) => p[1] === lastSet).sort((a, b) => num(a[2]) - num(b[2]))[0];

  const intl = { set: pick[1], number: pick[2] };
  try {
    const enHtml = await getText(`https://limitlesstcg.com/cards/en/${intl.set}/${intl.number}`, { ttlHours: Infinity });
    const $en = cheerio.load(enHtml);
    const official = $en('.card-text-name').first().text().trim();
    return { set, name: official || literal, intl, category: sectionOfType($en('.card-text-type').first().text()) ?? jpCategory };
  } catch {
    return { set, name: literal, intl, category: jpCategory };
  }
}

/**
 * @param {{id: string, name: string, alt: string, section?: string}} card  full JP name, "alt" JP name (without
 *   set) and the deck-list section it came from: a translation to another kind of card (a Pokémon for a Trainer)
 *   means the print was looked up in the wrong set, and it is discarded
 * @returns {Promise<{en: string|null, set: string|null, number: string|null, intl: object|null}>}
 */
export async function translateCard(card) {
  const r = await translateById(card);
  if (card.section && r.en && r.category && r.category !== card.section) return { en: null, set: null, number: null, intl: null };
  return r;
}

async function translateById(card) {
  const c = await load();
  if (c[card.id]) return c[card.id];

  const basic = card.alt.match(/^基本(.+)エネルギー$/);
  if (basic && BASIC_ENERGY[basic[1]]) {
    const [type, num] = BASIC_ENERGY[basic[1]];
    const r = { en: `${type} Energy`, set: null, number: null, intl: num ? { set: 'MEE', number: String(num) } : null };
    c[card.id] = r;
    dirty++;
    return r;
  }

  let result = { en: null, set: null, number: null, intl: null, v: 2 };
  try {
    const loc = parseSetFromName(card.name) ?? (await setFromOfficialDetails(card.id));
    if (loc) {
      result.set = loc.set;
      result.number = loc.number;
      const t = await englishNameFromLimitless(loc.set, loc.number);
      result.set = t.set; // Limitless code (old expansions are spelled differently)
      result.en = t.name;
      result.intl = t.intl;
      result.category = t.category;
    }
  } catch (e) {
    result.error = e.message;
    // transient errors: not cached so they are retried on the next run
    if (!/HTTP 404/.test(e.message)) return result;
  }
  c[card.id] = result;
  if (++dirty % 25 === 0) await saveTranslations();
  return result;
}
