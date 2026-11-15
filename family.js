// Archetype families: groups variants of the same main Pokémon
// (e.g. "Dragapult ex", "Dragapult ex / Dudunsparce ex" and "Dragapult ex / Blaziken ex" -> family "Dragapult").
import { normName } from './public/cardkey.js';

const stripEx = (s) => s.replace(/\s+ex$/i, '').trim();

/**
 * Family of a deck: the Pokémon in the deck that leads the archetype name.
 * Without a match (e.g. "Basic Box", "Festival Lead"), the family is the name itself.
 * @returns {{ key: string, name: string }}
 */
export function familyOfDeck(deck) {
  const lead = String(deck.archetype ?? '').split(' / ')[0].trim();
  const nlead = normName(lead);
  let best = null;
  for (const c of deck.cards ?? []) {
    if (c.section !== 'pokemon' || !c.name) continue;
    const base = normName(stripEx(c.name)); // "dragapult", "mega kangaskhan", "teal mask ogerpon"
    if (base.length < 3) continue;
    const species = base.split(' ').at(-1); // "ogerpon"
    const exact = nlead === normName(c.name) || nlead === base || nlead.startsWith(base + ' ');
    // "Ogerpon Meganium": the archetype starts with the species of "Teal Mask Ogerpon ex"
    const bySpecies = species.length >= 4 && (nlead === species || nlead.startsWith(species + ' '));
    if (!exact && !bySpecies) continue;
    const score = (exact ? 1000 : 0) + base.length;
    if (!best || score > best.score) best = { score, name: stripEx(c.name) };
  }
  const name = best?.name ?? lead;
  return { key: normName(name), name };
}

/** Gives every deck of the same archetype the most frequent family among them. */
export function assignFamilies(decks) {
  const votes = new Map(); // archetypeKey -> Map(familyKey -> {name, n})
  for (const d of decks) {
    const f = familyOfDeck(d);
    if (!votes.has(d.archetypeKey)) votes.set(d.archetypeKey, new Map());
    const m = votes.get(d.archetypeKey);
    const v = m.get(f.key) ?? { ...f, n: 0 };
    v.n++;
    m.set(f.key, v);
  }
  const chosen = new Map(
    [...votes.entries()].map(([ak, m]) => [ak, [...m.values()].sort((a, b) => b.n - a.n)[0]]),
  );
  for (const d of decks) {
    const f = chosen.get(d.archetypeKey);
    d.familyKey = f.key;
    d.family = f.name;
  }
}
