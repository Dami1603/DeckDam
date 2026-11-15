// Familias de arquetipos: agrupa variantes del mismo Pokémon principal
// (ej. "Dragapult ex", "Dragapult ex / Dudunsparce ex" y "Dragapult ex / Blaziken ex" -> familia "Dragapult").
import { normName } from './public/cardkey.js';

const stripEx = (s) => s.replace(/\s+ex$/i, '').trim();

/**
 * Familia de un mazo: el Pokémon del mazo que encabeza el nombre del arquetipo.
 * Sin coincidencia (ej. "Basic Box", "Festival Lead"), la familia es el propio nombre.
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
    // "Ogerpon Meganium": el arquetipo empieza por la especie de "Teal Mask Ogerpon ex"
    const bySpecies = species.length >= 4 && (nlead === species || nlead.startsWith(species + ' '));
    if (!exact && !bySpecies) continue;
    const score = (exact ? 1000 : 0) + base.length;
    if (!best || score > best.score) best = { score, name: stripEx(c.name) };
  }
  const name = best?.name ?? lead;
  return { key: normName(name), name };
}

/** Asigna a todos los mazos de un mismo arquetipo la familia más frecuente entre ellos. */
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
