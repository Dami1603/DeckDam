// Abilities and attacks of a Pokémon from its Limitless card page (permanent cache).
import * as cheerio from 'cheerio';
import { getText } from './http.js';

const memo = new Map();

/**
 * @param {{set: string, number: string, lang?: 'en'|'jp'}} print
 * @returns {Promise<{attacks: string[], abilities: string[]}|null>} null if it could not be read
 */
export async function getMoves({ set, number, lang = 'en' }) {
  if (!set || !number) return null;
  if (lang === 'jp' && /^[A-Za-z]+-P$/.test(set)) set = set.replace('-', '');
  const url =
    lang === 'jp'
      ? `https://limitlesstcg.com/cards/jp/${encodeURIComponent(set)}/${number}?translate=en`
      : `https://limitlesstcg.com/cards/en/${encodeURIComponent(set)}/${number}`;
  if (memo.has(url)) return memo.get(url);

  const p = (async () => {
    try {
      const html = await getText(url, { ttlHours: Infinity });
      // Japanese print with an international version: the official English attacks of that version are used
      // (the literal translation of the Japanese sheet may differ and would split the card identity).
      if (lang === 'jp') {
        const section = html.split('Int. Prints')[1]?.split('JP. Prints')[0] ?? '';
        const intl = [...section.matchAll(/href="\/cards\/en\/([A-Za-z0-9-]+)\/(\w+)"/g)].at(-1);
        if (intl) {
          const en = await getMoves({ set: intl[1], number: intl[2], lang: 'en' });
          if (en) return en;
        }
      }
      const $ = cheerio.load(html);
      const attacks = [];
      const abilities = [];
      $('.card-text-ability-info').each((_, el) => {
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        // "Ability: Teal Dance", "Poké-Power: X", "Poké-Body: X" (the "Tera" rule, without ':', is ignored)
        const m = t.match(/^(?:Ability|Poké-Power|Poké-Body|Pokémon Power|Poke-Power|Poke-Body)\s*:\s*(.+)$/i);
        if (m) abilities.push(m[1].trim());
      });
      $('.card-text-attack-info').each((_, el) => {
        const $el = $(el).clone();
        $el.find('.ptcg-symbol').remove();
        const t = $el.text().replace(/\s+/g, ' ').trim().replace(/\s+\d+\s*[+×x-]?$/, '').trim();
        if (t) attacks.push(t);
      });
      return attacks.length || abilities.length ? { attacks, abilities } : null;
    } catch {
      return null;
    }
  })();
  memo.set(url, p);
  return p;
}

const TCGDEX_EN = 'https://api.tcgdex.net/v2/en';
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const idOf = (m) => [...new Set((m.attacks.length ? m.attacks : m.abilities).map(norm))].sort().join('|');

/**
 * Old Japanese prints (Black & White / XY, played in Expanded) are not in Limitless' Japanese card database.
 * Their English version is looked up on TCGdex in the English sets of the same era and number (± 1, since the
 * English releases merge and shift the Japanese ones). Only an unambiguous match is used: a single identity
 * (name + attacks) among the candidates, or the print with the same number in the matching set.
 * @returns {Promise<{attacks: string[], abilities: string[]}|null>}
 */
export async function getMovesOldJp({ name, set, number }) {
  const m = String(set ?? '').match(/^(BW|XY)(\d+)/i);
  if (!m || !name) return null;
  const era = m[1].toLowerCase();
  const n = Number(m[2]);
  const ids = [n, n - 1, n + 1].filter((i) => i > 0).map((i) => `${era}${i}`);
  const key = `old:${ids[0]}:${norm(name)}:${number}`;
  if (memo.has(key)) return memo.get(key);
  const p = (async () => {
    const found = [];
    for (const id of ids) {
      let setData;
      try {
        setData = JSON.parse(await getText(`${TCGDEX_EN}/sets/${id}`, { ttlHours: Infinity }));
      } catch {
        continue;
      }
      for (const c of setData.cards ?? []) {
        if (norm(c.name) !== norm(name)) continue;
        try {
          const card = JSON.parse(await getText(`${TCGDEX_EN}/cards/${encodeURIComponent(c.id)}`, { ttlHours: Infinity }));
          const moves = { attacks: (card.attacks ?? []).map((a) => a.name), abilities: (card.abilities ?? []).map((a) => a.name) };
          if (moves.attacks.length || moves.abilities.length) found.push({ moves, sameNumber: id === ids[0] && Number(c.localId) === Number(number) });
        } catch {}
      }
    }
    const identities = new Set(found.map((f) => idOf(f.moves)));
    if (identities.size === 1) return found[0].moves;
    return found.find((f) => f.sameNumber)?.moves ?? null;
  })();
  memo.set(key, p);
  return p;
}
