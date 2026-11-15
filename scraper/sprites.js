// Sprites de Pokémon al estilo de Limitless (https://r2.limitlesstcg.net/pokemon/gen9/<slug>.png) para los mazos
// que no los traen de origen (arquetipos que sólo existen en Pokecabook o Pokedata).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName } from '../public/cardkey.js';
import { mapLimit } from './http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = path.join(ROOT, 'data', 'sprites.json');
const BASE = 'https://r2.limitlesstcg.net/pokemon/gen9';

const REGIONAL = { alolan: 'alola', galarian: 'galar', hisuian: 'hisui', paldean: 'paldea', bloodmoon: 'bloodmoon' };

/**
 * Slugs posibles para un nombre de carta, del más específico al más general.
 * "Mega Kangaskhan ex" -> kangaskhan-mega, kangaskhan · "N's Zoroark ex" -> zoroark
 * "Alolan Exeggutor" -> exeggutor-alola, exeggutor · "Mega Charizard Y ex" -> charizard-mega-y, charizard
 * "Wellspring Mask Ogerpon ex" -> ogerpon-wellspring, ogerpon · "Teal Mask Ogerpon ex" -> ogerpon
 */
export function spriteSlugs(name) {
  let n = normName(name).replace(/\s+ex$/, '').replace(/\s+(v|vstar|vmax|gx)$/, '');
  n = n.replace(/^[a-z0-9 .-]+?'s\s+/, ''); // dueño: "N's", "Team Rocket's", "Lillie's"…
  let mega = '';
  if (n.startsWith('mega ')) {
    n = n.slice(5);
    const xy = n.match(/^(.*)\s+([xy])$/);
    mega = xy ? `-mega-${xy[2]}` : '-mega';
    if (xy) n = xy[1];
  }
  let form = '';
  for (const [prefix, suffix] of Object.entries(REGIONAL)) {
    if (n.startsWith(prefix + ' ')) {
      form = suffix;
      n = n.slice(prefix.length + 1);
    }
  }
  const mask = n.match(/^(teal|wellspring|hearthflame|cornerstone) mask (ogerpon)$/);
  if (mask) {
    n = 'ogerpon';
    form = mask[1] === 'teal' ? '' : mask[1];
  }
  const base = n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!base) return [];
  const out = [];
  if (mega) out.push(base + mega);
  if (form) out.push(`${base}-${form}`);
  out.push(base);
  return [...new Set(out)];
}

let cache = null;
async function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

async function exists(slug) {
  const c = await loadCache();
  if (slug in c) return c[slug];
  try {
    const res = await fetch(`${BASE}/${slug}.png`, { method: 'HEAD' });
    c[slug] = res.ok;
  } catch {
    return false; // error de red: no se cachea
  }
  return c[slug];
}

/** Primer sprite existente para un nombre (o null). */
async function spriteFor(name) {
  for (const slug of spriteSlugs(name)) if (await exists(slug)) return `${BASE}/${slug}.png`;
  return null;
}

/**
 * Agrega `icons` a los mazos que no los tienen: sprite de cada Pokémon del nombre del arquetipo (máx. 2).
 * Si una parte del nombre no es un Pokémon (ej. "Crustle Mysterious Rock Inn"), se prueba con su primera palabra.
 */
export async function addMissingSprites(decks, log = console.log) {
  const pending = decks.filter((d) => !d.icons?.length && d.archetype);
  const names = new Set();
  for (const d of pending) for (const part of d.archetype.split(' / ').slice(0, 2)) names.add(part.trim());
  const resolved = new Map();
  await mapLimit([...names], 6, async (part) => {
    resolved.set(part, (await spriteFor(part)) ?? (await spriteFor(part.split(' ')[0])));
  });
  let added = 0;
  for (const d of pending) {
    const icons = d.archetype
      .split(' / ')
      .slice(0, 2)
      .map((p) => resolved.get(p.trim()))
      .filter(Boolean);
    if (icons.length) {
      d.icons = [...new Set(icons)];
      added++;
    }
  }
  await writeFile(CACHE_FILE, JSON.stringify(cache ?? {}, null, 1), 'utf8');
  log(`[sprites] íconos agregados a ${added} de ${pending.length} mazos sin ícono`);
}

/**
 * Acompañante en los mazos de un solo nombre (ej. "Dragapult ex"): de las combinaciones conocidas del meta
 * (arquetipos "X / Y", ej. "Dragapult ex / Blaziken ex") se toma la que la lista realmente lleva, con más copias,
 * y se agrega su sprite como segundo ícono.
 */
export async function addCompanionSprites(decks, familyOfDeck, log = console.log) {
  // familia principal -> acompañante -> cantidad de mazos con esa combinación
  const pairs = new Map();
  for (const d of decks) {
    const parts = String(d.archetype ?? '').split(' / ');
    if (parts.length < 2) continue;
    const fam = familyOfDeck(d).key;
    const partner = parts[1].trim();
    if (!pairs.has(fam)) pairs.set(fam, new Map());
    pairs.get(fam).set(partner, (pairs.get(fam).get(partner) ?? 0) + 1);
  }
  // cartas de soporte genéricas (Meowth ex, Fezandipiti ex, Munkidori…) no cuentan como acompañante:
  // las que están en el 30% o más de TODAS las listas
  const maxGlobal = Number(process.env.COMPANION_MAX_GLOBAL ?? 0.3);
  const minPairs = Number(process.env.COMPANION_MIN_PAIRS ?? 2);
  const presence = new Map();
  for (const d of decks) for (const nk of new Set(d.cards.map((c) => normName(c.name)))) presence.set(nk, (presence.get(nk) ?? 0) + 1);
  const generic = (name) => (presence.get(normName(name)) ?? 0) / decks.length >= maxGlobal;

  // al rehacer los datos, se recalcula desde el ícono principal
  for (const d of decks) {
    if (d.companion && d.icons?.length === 2) d.icons = [d.icons[0]];
    delete d.companion;
  }

  let added = 0;
  const sprites = new Map();
  for (const d of decks) {
    if (String(d.archetype ?? '').includes(' / ') || (d.icons?.length ?? 0) !== 1) continue;
    const partners = pairs.get(familyOfDeck(d).key);
    if (!partners) continue;
    let best = null;
    for (const [partner, freq] of partners) {
      if (freq < minPairs || generic(partner)) continue;
      const np = normName(partner);
      const copies = d.cards.filter((c) => c.section === 'pokemon' && normName(c.name) === np).reduce((n, c) => n + c.count, 0);
      if (copies && (!best || copies > best.copies || (copies === best.copies && freq > best.freq))) best = { partner, copies, freq };
    }
    if (!best) continue;
    if (!sprites.has(best.partner)) sprites.set(best.partner, await spriteFor(best.partner));
    const icon = sprites.get(best.partner);
    if (icon && icon !== d.icons[0]) {
      d.icons = [d.icons[0], icon];
      d.companion = best.partner;
      added++;
    }
  }
  await writeFile(CACHE_FILE, JSON.stringify(cache ?? {}, null, 1), 'utf8');
  log(`[sprites] acompañante agregado a ${added} mazos de un solo nombre`);
}
