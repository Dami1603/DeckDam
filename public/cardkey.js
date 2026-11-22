// Card identity, shared by the server, the scraper and the browser.
//
// In the TCG two cards with the same name can be different (e.g. several "Moltres" with
// different attacks). That is why Pokémon are identified by name + abilities + attacks:
// reprints (same text) count together and different versions are not mixed.
// Trainers and Energy are identified by name only.

/** Normalizes a text to compare across TCGdex, Limitless and JP translations. */
export function normName(s = '') {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑–—]/g, '-')
    .replace(/[◇◊]/g, '♢') // Prism Star: TCGdex writes "◇", Limitless "♢"
    .toLowerCase()
    .replace(/\s*\(ace spec\)\s*/g, ' ')
    .replace(/^basic\s+(\w+\s+energy)$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pokémon: name + attacks (or abilities if it has no attacks). Attacks are used because
 * TCGdex does not always list abilities/VSTAR powers, and different versions differ in attacks.
 * @param {string} name
 * @param {{attacks?: string[], abilities?: string[]}|null} moves null for Trainer/Energy
 */
export function cardKey(name, moves = null) {
  const base = normName(name);
  if (!moves) return base;
  const list = moves.attacks?.length ? moves.attacks : moves.abilities ?? [];
  const m = [...new Set(list.map(normName).filter(Boolean))].sort();
  return m.length ? `${base}|${m.join('|')}` : base;
}

/** Key of a TCGdex card (detail object /cards/{id}). */
export function tcgdexKey(card) {
  if (!card) return null;
  if (card.category !== 'Pokemon') return cardKey(card.name);
  return cardKey(card.name, {
    attacks: (card.attacks ?? []).map((a) => a.name),
    abilities: (card.abilities ?? []).map((a) => a.name),
  });
}

export const nameOfKey = (key) => String(key).split('|')[0];
