// Identidad de una carta, compartida por servidor, scraper y navegador.
//
// En el TCG dos cartas con el mismo nombre pueden ser distintas (ej. varios "Moltres" con
// ataques diferentes). Por eso los Pokémon se identifican por nombre + habilidades + ataques:
// las reimpresiones (mismo texto) cuentan juntas y las versiones distintas no se mezclan.
// Entrenadores y Energías se identifican sólo por el nombre.

/** Normaliza un texto para comparar entre TCGdex, Limitless y traducciones JP. */
export function normName(s = '') {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑–—]/g, '-')
    .toLowerCase()
    .replace(/\s*\(ace spec\)\s*/g, ' ')
    .replace(/^basic\s+(\w+\s+energy)$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pokémon: nombre + ataques (o habilidades si no tiene ataques). Se usan los ataques porque
 * TCGdex no siempre lista habilidades/poderes VSTAR, y las versiones distintas difieren en ataques.
 * @param {string} name
 * @param {{attacks?: string[], abilities?: string[]}|null} moves null para Entrenador/Energía
 */
export function cardKey(name, moves = null) {
  const base = normName(name);
  if (!moves) return base;
  const list = moves.attacks?.length ? moves.attacks : moves.abilities ?? [];
  const m = [...new Set(list.map(normName).filter(Boolean))].sort();
  return m.length ? `${base}|${m.join('|')}` : base;
}

/** Clave de una carta de TCGdex (objeto de detalle /cards/{id}). */
export function tcgdexKey(card) {
  if (!card) return null;
  if (card.category !== 'Pokemon') return cardKey(card.name);
  return cardKey(card.name, {
    attacks: (card.attacks ?? []).map((a) => a.name),
    abilities: (card.abilities ?? []).map((a) => a.name),
  });
}

export const nameOfKey = (key) => String(key).split('|')[0];
