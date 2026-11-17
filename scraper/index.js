// Usage:
//   npm run scrape                          -> active sources (Limitless + Limitless JP + Pokecabook + Pokedata + Pokecabook Expanded)
//   npm run scrape -- --only=limitless-jp   -> a single source (the other active ones are kept)
//   SOURCES=limitless,limitless-jp npm run scrape   -> choose the active sources
// Sources that are not active are removed from data/decks.json.
// Optional variables: LIMITLESS_ARCHETYPES, LIMITLESS_LISTS, LIMITLESS_JP_DAYS, LIMITLESS_JP_TOP, POKEDATA_TOP, POKEDATA_SINCE,
//   POKECABOOK_ARTICLES, POKECABOOK_DECKS, POKECABOOK_EXPANDED_ARTICLES, POKECABOOK_EXPANDED_DECKS, SCRAPE_DELAY_MS
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrapeLimitless } from './limitless.js';
import { scrapePokecabook, scrapePokecabookExpanded } from './pokecabook.js';
import { scrapeLimitlessJp } from './limitless-jp.js';
import { scrapePokedata } from './pokedata.js';
import { buildProfiles, classifyDeck } from './classify.js';
import { addMissingSprites, addCompanionSprites } from './sprites.js';
import { familyOfDeck } from '../family.js';
import { getMoves, getMovesOldJp } from './cardtext.js';
import { mapLimit } from './http.js';
import { cardKey } from '../public/cardkey.js';
import { limitlessImage } from './limitless.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'decks.json');
const LOCK = path.join(ROOT, 'data', '.scrape.lock');

// One scrape at a time (manual or launched by the server). Exit code 2 = one was already running.
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
try {
  const pid = Number(await readFile(LOCK, 'utf8'));
  if (pid && pid !== process.pid && isAlive(pid)) {
    console.error(`A scrape is already running (process ${pid}).`);
    process.exit(2);
  }
} catch {}
await mkdir(path.dirname(LOCK), { recursive: true });
await writeFile(LOCK, String(process.pid));
process.on('exit', () => {
  try {
    unlinkSync(LOCK);
  } catch {}
});

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const SCRAPERS = {
  limitless: () => scrapeLimitless(),
  'limitless-jp': () => scrapeLimitlessJp(),
  pokecabook: () => scrapePokecabook(),
  'pokecabook-expanded': () => scrapePokecabookExpanded(),
  pokedata: () => scrapePokedata({ since: pokedataSince() }),
};
const DEFAULT_SOURCES = ['limitless', 'limitless-jp', 'pokecabook', 'pokedata', 'pokecabook-expanded'];
const enabled = (process.env.SOURCES ? process.env.SOURCES.split(',') : DEFAULT_SOURCES).map((s) => s.trim());
const only = args.only ? String(args.only).split(',') : enabled;
for (const s of only) if (!enabled.includes(s)) enabled.push(s);
const unknown = only.filter((s) => !SCRAPERS[s]);
if (unknown.length) throw new Error(`Unknown source: ${unknown.join(', ')} (options: ${Object.keys(SCRAPERS).join(', ')})`);

let previous = { decks: [], sources: {} };
try {
  previous = JSON.parse(await readFile(OUT, 'utf8'));
} catch {}

const results = {};
const t0 = Date.now();
/**
 * Official tournaments to take from pokedata: since the start of the current format, estimated as the oldest
 * list of the current format on Limitless (or POKEDATA_SINCE, or the last 150 days).
 */
function pokedataSince() {
  if (process.env.POKEDATA_SINCE) return process.env.POKEDATA_SINCE;
  const lim = results.limitless ?? previous.decks.filter((d) => d.source === 'limitless');
  const dates = lim.map((d) => d.date).filter(Boolean).sort();
  return dates[0] ?? new Date(Date.now() - 150 * 86400_000).toISOString().slice(0, 10);
}

// pokedata is classified with the archetypes of the other sources: it goes last
only.sort((a, b) => Number(a === 'pokedata') - Number(b === 'pokedata'));
for (const src of only) results[src] = await SCRAPERS[src]();

const now = new Date().toISOString();
const sources = Object.fromEntries(Object.entries(previous.sources ?? {}).filter(([k]) => enabled.includes(k)));
let decks = previous.decks.filter((d) => enabled.includes(d.source) && !(d.source in results));
for (const [src, list] of Object.entries(results)) {
  if (!list.length && previous.decks.some((d) => d.source === src)) {
    console.warn(`[${src}] 0 decks: keeping the previous data`);
    decks.push(...previous.decks.filter((d) => d.source === src));
    continue;
  }
  decks.push(...list);
  sources[src] = { updatedAt: now, decks: list.length };
}
// Merges Pokecabook archetypes with Limitless names when there is a single match
// (e.g. "Alakazam" -> "Alakazam Powerful Hand"), so both sources count together.
const limArchetypes = [...new Set(decks.filter((d) => d.source === 'limitless').map((d) => d.archetype))];
const limByName = new Map(decks.filter((d) => d.source === 'limitless').map((d) => [d.archetype, d]));
for (const d of decks) {
  if (d.source !== 'pokecabook') continue;
  d.archetype = d.archetypeEn ?? d.archetype;
  d.archetypeEn = d.archetype;
  const lead = d.archetype.split(' / ')[0].toLowerCase();
  const exact = limArchetypes.filter((n) => n.toLowerCase() === lead);
  const prefix = limArchetypes.filter((n) => n.toLowerCase().startsWith(lead + ' '));
  const match = exact.length === 1 ? exact[0] : !exact.length && prefix.length === 1 ? prefix[0] : null;
  if (match) {
    d.archetype = match;
    d.archetypeId = limByName.get(match).archetypeId;
    if (!d.icons?.length) d.icons = limByName.get(match).icons;
    continue;
  }
  // otherwise, the same exact name as a City League JP archetype (e.g. "Alakazam / Dudunsparce")
  const jp = decks.find((x) => x.source === 'limitless-jp' && x.archetype.toLowerCase() === d.archetype.toLowerCase());
  if (jp) {
    d.archetypeId = jp.archetypeId;
    if (!d.icons?.length) d.icons = jp.icons;
  }
}

// Pokedata: without duplicating lists Limitless already has (same player, same tournament) and with an archetype
const playerKey = (p) => (p ?? '').replace(/\s*\[[A-Z]{2}\]\s*$/, '').trim().toLowerCase();
const limSeen = decks.filter((d) => d.source === 'limitless' && d.player && d.date);
decks = decks.filter((d) => {
  if (d.source !== 'pokedata') return true;
  const pk = playerKey(d.player);
  return !limSeen.some((l) => playerKey(l.player) === pk && Math.abs(new Date(l.date) - new Date(d.date)) <= 4 * 86400_000);
});
const profiles = buildProfiles(decks);

// Pokecabook: articles whose title is a nickname with no recognizable Pokémon (e.g. "おまつりおんど", which would
// become "Grookey"): the most similar known archetype by Pokémon is looked up and, if most decks of the
// article match, that name is used for the whole article (e.g. "Festival Lead").
const knownNames = new Set(decks.filter((d) => d.source === 'limitless' || d.source === 'limitless-jp').map((d) => d.archetype));
const pcbByArticle = new Map();
for (const d of decks) {
  if (d.source !== 'pokecabook' || d.titleMatched !== false || knownNames.has(d.archetype)) continue;
  if (!pcbByArticle.has(d.archetypeJp)) pcbByArticle.set(d.archetypeJp, []);
  pcbByArticle.get(d.archetypeJp).push(d);
}
let pcbRenamed = 0;
for (const [jp, group] of pcbByArticle) {
  const votes = new Map();
  const results = group.map((d) => classifyDeck(d, profiles, Number(process.env.CLASSIFY_THRESHOLD_POKECABOOK ?? 0.75)));
  for (const c of results) if (c.matched) votes.set(c.archetype, (votes.get(c.archetype) ?? 0) + 1);
  const [winner, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!winner || n < group.length / 2) continue;
  const ref = results.find((c) => c.archetype === winner);
  for (const d of group) {
    d.archetype = d.title = winner;
    d.archetypeId = ref.archetypeId;
    if (!d.icons?.length) d.icons = ref.icons;
  }
  pcbRenamed += group.length;
  console.log(`[pokecabook] "${jp}" -> ${winner} (${n}/${group.length} decks by similarity)`);
}

let classified = 0;
const pdDecks = decks.filter((d) => d.source === 'pokedata');
for (const d of pdDecks) {
  const c = classifyDeck(d, profiles);
  d.archetype = d.title = c.archetype;
  d.archetypeId = c.archetypeId;
  d.icons = c.icons;
  d.similarity = Math.round(c.similarity * 100) / 100;
  if (c.matched) classified++;
}
if (pdDecks.length) console.log(`[pokedata] archetypes: ${classified} of ${pdDecks.length} lists recognized; the rest named by their main Pokémon`);

// Identity of each card: Pokémon are told apart by their attacks (see public/cardkey.js)
let unresolved = 0;
await mapLimit(decks, 4, async (d) => {
  for (const c of d.cards) {
    if (c.section !== 'pokemon') {
      c.key = cardKey(c.name);
      continue;
    }
    let print = null;
    if (!d.source.startsWith('pokecabook')) print = c.set ? { set: c.set, number: c.number, lang: c.lang ?? 'en' } : null;
    else {
      const fromImg = c.image?.match(/\/tpci\/([A-Za-z0-9-]+)\/\1_(\w+?)_R_EN/);
      const enSet = c.enSet ?? fromImg?.[1];
      const enNumber = c.enNumber ?? (fromImg ? String(Number(fromImg[2]) || fromImg[2]) : null);
      print = enSet ? { set: enSet, number: enNumber, lang: 'en' } : c.set ? { set: c.set, number: c.number, lang: 'jp' } : null;
    }
    let moves = print ? await getMoves(print) : null;
    // official tournament lists with Japanese prints (e.g. "M1S 89"): the Japanese card sheet is looked up
    if (!moves && print?.lang === 'en' && !d.source.startsWith('pokecabook')) {
      moves = await getMoves({ ...print, lang: 'jp' });
      if (moves) {
        c.lang = 'jp';
        c.image = limitlessImage(c.set, c.number, 'jp');
      }
    }
    // Black & White / XY Japanese prints (Expanded): English version of the same era on TCGdex
    if (!moves && print?.lang === 'jp' && d.format === 'expanded') moves = await getMovesOldJp({ name: c.name, set: print.set, number: print.number });
    if (!moves) unresolved++;
    c.attacks = moves?.attacks ?? [];
    c.abilities = moves?.abilities ?? [];
    c.key = cardKey(c.name, moves);
  }
});
console.log(`[cards] attacks read; Pokémon without a sheet: ${unresolved}`);

// main Pokémon sprites (Limitless style) for decks that do not come with them
await addMissingSprites(decks);
await addCompanionSprites(decks, familyOfDeck);

decks.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

await mkdir(path.dirname(OUT), { recursive: true });
// atomic write: the server never reads a half-written file
await writeFile(OUT + '.tmp', JSON.stringify({ updatedAt: now, sources, decks }), 'utf8');
await rename(OUT + '.tmp', OUT);
console.log(`\n✓ ${decks.length} decks saved to data/decks.json (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
