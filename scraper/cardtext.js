// Habilidades y ataques de un Pokémon desde su ficha en Limitless (caché permanente).
import * as cheerio from 'cheerio';
import { getText } from './http.js';

const memo = new Map();

/**
 * @param {{set: string, number: string, lang?: 'en'|'jp'}} print
 * @returns {Promise<{attacks: string[], abilities: string[]}|null>} null si no se pudo leer
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
      // Impresión japonesa con versión internacional: se usan los ataques oficiales en inglés de esa versión
      // (la traducción literal de la ficha japonesa puede diferir y partiría la identidad de la carta).
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
        // "Ability: Teal Dance", "Poké-Power: X", "Poké-Body: X" (se ignora la regla "Tera", sin ':')
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
