// Assigns an archetype to lists that come without one (pokedata), comparing them with known archetypes.
// Each list is represented by its Pokémon (name -> copies, max. 4) and compared by cosine similarity
// with the average profile of each Limitless (preferred) and City League JP archetype.
import { normName } from '../public/cardkey.js';

const LABELED_SOURCES = ['limitless', 'limitless-jp'];

function pokemonVector(deck) {
  const v = new Map();
  for (const c of deck.cards) {
    if (c.section !== 'pokemon') continue;
    const k = normName(c.name);
    v.set(k, Math.min(4, (v.get(k) ?? 0) + c.count));
  }
  return v;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, x] of a) {
    na += x * x;
    const y = b.get(k);
    if (y) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Average profiles per archetype (at least 2 lists). */
export function buildProfiles(decks) {
  const groups = new Map();
  for (const d of decks) {
    if (!LABELED_SOURCES.includes(d.source) || !d.archetype) continue;
    const key = `${d.source}|${d.archetype}`;
    if (!groups.has(key)) groups.set(key, { name: d.archetype, source: d.source, archetypeId: d.archetypeId, icons: d.icons ?? [], decks: [] });
    groups.get(key).decks.push(d);
  }
  const profiles = [];
  for (const g of groups.values()) {
    if (g.decks.length < 2) continue;
    const sum = new Map();
    for (const d of g.decks) for (const [k, x] of pokemonVector(d)) sum.set(k, (sum.get(k) ?? 0) + x);
    for (const [k, x] of sum) sum.set(k, x / g.decks.length);
    profiles.push({ ...g, vector: sum, size: g.decks.length });
  }
  return profiles;
}

/** Fallback name: the ex/Mega Pokémon with the most copies (or the one with the most copies). */
function fallbackName(deck) {
  const poke = deck.cards.filter((c) => c.section === 'pokemon').sort((a, b) => b.count - a.count);
  return (poke.find((c) => / ex$|^Mega /.test(c.name)) ?? poke[0])?.name ?? 'Other';
}

/**
 * @returns {{archetype: string, archetypeId: string|null, icons: string[], similarity: number, matched: boolean}}
 */
export function classifyDeck(deck, profiles, threshold = Number(process.env.CLASSIFY_THRESHOLD ?? 0.7)) {
  const v = pokemonVector(deck);
  let best = { limitless: null, 'limitless-jp': null };
  for (const p of profiles) {
    const s = cosine(v, p.vector);
    if (!best[p.source] || s > best[p.source].s) best[p.source] = { p, s };
  }
  // the international Limitless name is preferred (same tournament circuit)
  const pick = [best.limitless, best['limitless-jp']].find((b) => b && b.s >= threshold);
  if (pick) {
    return { archetype: pick.p.name, archetypeId: pick.p.archetypeId, icons: pick.p.icons, similarity: pick.s, matched: true };
  }
  const name = fallbackName(deck);
  return { archetype: name, archetypeId: `auto-${normName(name)}`, icons: [], similarity: 0, matched: false };
}
