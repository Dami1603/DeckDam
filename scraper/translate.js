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

let cache = null;
let dirty = 0;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    cache = {};
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
  if (!set || !numMatch) return null;
  return { set, number: String(Number(numMatch[1])) };
}

// Promos: the official code has a hyphen ("SV-P", "M-P") and the Limitless one does not ("SVP", "MP")
const limitlessSetCode = (set) => (/^[A-Za-z]+-P$/.test(set) ? set.replace('-', '') : set);

async function englishNameFromLimitless(rawSet, number) {
  const set = limitlessSetCode(rawSet);
  const html = await getText(
    `https://limitlesstcg.com/cards/jp/${encodeURIComponent(set)}/${number}?translate=en`,
    { ttlHours: Infinity },
  );
  const $ = cheerio.load(html);
  const literal = $('.card-text-name').first().text().trim() || null;

  // International prints (chronological order): the most recent gives the official
  // English name (the literal translation may differ, e.g. "Boss's Command" vs "Boss's Orders")
  const section = html.split('Int. Prints')[1]?.split('JP. Prints')[0] ?? '';
  const prints = [...section.matchAll(/href="\/cards\/en\/([A-Za-z0-9-]+)\/(\w+)"/g)];
  if (!prints.length) return { name: literal, intl: null };
  // from the most recent set, the lowest-numbered print (regular version, not the secret/gold rare)
  const lastSet = prints.at(-1)[1];
  const num = (n) => (/^\d+$/.test(n) ? Number(n) : Infinity);
  const pick = prints.filter((p) => p[1] === lastSet).sort((a, b) => num(a[2]) - num(b[2]))[0];

  const intl = { set: pick[1], number: pick[2] };
  try {
    const enHtml = await getText(`https://limitlesstcg.com/cards/en/${intl.set}/${intl.number}`, { ttlHours: Infinity });
    const official = cheerio.load(enHtml)('.card-text-name').first().text().trim();
    return { name: official || literal, intl };
  } catch {
    return { name: literal, intl };
  }
}

/**
 * @param {{id: string, name: string, alt: string}} card  full JP name and "alt" JP name (without set)
 * @returns {Promise<{en: string|null, set: string|null, number: string|null, intl: object|null}>}
 */
export async function translateCard(card) {
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

  let result = { en: null, set: null, number: null, intl: null };
  try {
    const loc = parseSetFromName(card.name) ?? (await setFromOfficialDetails(card.id));
    if (loc) {
      result.set = loc.set;
      result.number = loc.number;
      const t = await englishNameFromLimitless(loc.set, loc.number);
      result.en = t.name;
      result.intl = t.intl;
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
