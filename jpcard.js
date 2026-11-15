// Card sheet of a Japanese card (not yet released in English) from Limitless, translated to English
// (https://limitlesstcg.com/cards/jp/SET/N?translate=en), in the same shape as TCGdex.
import * as cheerio from 'cheerio';
import { getText } from './scraper/http.js';

const CDN = 'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpc';
const limitlessSet = (set) => (/^[A-Za-z]+-P$/.test(set) ? set.replace('-', '') : set); // "M-P" -> "MP"
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** JP card sheet in a TCGdex-like shape. */
export async function fetchJpCard({ set, number }) {
  const code = limitlessSet(set);
  const n = String(Number(number) || number);
  const html = await getText(`https://limitlesstcg.com/cards/jp/${encodeURIComponent(code)}/${encodeURIComponent(n)}?translate=en`, {
    ttlHours: 24 * 7,
  });
  const $ = cheerio.load(html);
  const name = clean($('.card-text-name').first().text());
  if (!name) throw new Error('Card sheet not found');

  // "Mega Heatran ex - Metal - 300 HP"
  const titleParts = clean($('.card-text-title').first().text()).split(' - ').map(clean);
  const hp = titleParts.map((p) => p.match(/^(\d+)\s*HP$/i)?.[1]).find(Boolean);
  const type = titleParts.length >= 3 ? titleParts[1] : null;
  // "Pokémon - Basic" / "Trainer - Item" / "Energy - Special Energy"
  const typeLine = clean($('.card-text-type').first().text()).split(' - ').map(clean);
  const kind = /pok/i.test(typeLine[0]) ? 'Pokemon' : /trainer/i.test(typeLine[0]) ? 'Trainer' : 'Energy';

  const abilities = [];
  $('.card-text-ability').each((_, el) => {
    const info = clean($(el).find('.card-text-ability-info').text());
    const m = info.match(/^(Ability|Poké-Power|Poké-Body)\s*:\s*(.+)$/i);
    if (m) abilities.push({ type: 'Ability', name: m[2], effect: clean($(el).find('.card-text-ability-effect').text()) });
  });
  const attacks = [];
  $('.card-text-attack').each((_, el) => {
    const info = $(el).find('.card-text-attack-info').clone();
    const cost = clean(info.find('.ptcg-symbol').text()).replace(/\s/g, '').split('').filter(Boolean);
    info.find('.ptcg-symbol').remove();
    const t = clean(info.text());
    const m = t.match(/^(.*?)\s+(\d+\s*[+×x-]?)$/);
    attacks.push({
      cost,
      name: m ? m[1] : t,
      damage: m ? m[2].replace(/\s/g, '').replace('x', '×') : undefined,
      effect: clean($(el).find('.card-text-attack-effect').text()) || undefined,
    });
  });

  const wrr = clean($('.card-text-wrr').first().text());
  const weak = wrr.match(/Weakness:\s*([A-Za-z]+)/i)?.[1];
  const resist = wrr.match(/Resistance:\s*([A-Za-z]+)/i)?.[1];
  const retreat = wrr.match(/Retreat:\s*(\d+)/i)?.[1];

  // Trainers/Energy: the card text is the section that follows the type
  let effect;
  if (kind !== 'Pokemon') {
    effect = $('.card-text-section')
      .eq(1)
      .find('p')
      .map((_, p) => clean($(p).text()))
      .get()
      .filter((p) => p && !/^(Weakness|Resistance|Retreat):/i.test(p))
      .join('\n');
  }

  const legality = {};
  $('.card-legality-item').each((_, el) => {
    const label = clean($(el).find('a').first().text());
    legality[label] = $(el).find('.legal').length > 0;
  });
  const setName = clean($('title').text()).match(/ - (.*) \([A-Za-z0-9-]+\) #/)?.[1] ?? code;
  const img = (size) => `${CDN}/${code}/${code}_${n}_R_JP_${size}.png`;

  return {
    id: `jp-${code}-${n}`,
    localId: n,
    name,
    category: kind,
    stage: kind === 'Pokemon' ? typeLine[1] : undefined,
    trainerType: kind === 'Trainer' ? typeLine[1] : undefined,
    energyType: kind === 'Energy' ? typeLine[1] : undefined,
    hp: hp ? Number(hp) : undefined,
    types: type ? [type] : undefined,
    abilities,
    attacks,
    effect,
    weaknesses: weak && !/none/i.test(weak) ? [{ type: weak, value: '×2' }] : undefined,
    resistances: resist && !/none/i.test(resist) ? [{ type: resist, value: '-30' }] : undefined,
    retreat: retreat != null ? Number(retreat) : undefined,
    illustrator: clean($('.card-text-artist a').first().text()) || undefined,
    regulationMark: clean($('.regulation-mark').first().text()).match(/^([A-Z])\s+Regulation/)?.[1],
    set: { id: `jp-${code}`, name: setName },
    legal: { standard: Boolean(legality['Standard (JP)']), standardJp: Boolean(legality['Standard (JP)']) },
    jpOnly: true,
    limitlessUrl: `https://limitlesstcg.com/cards/jp/${code}/${n}?translate=en`,
    _img: { low: img('SM'), high: img('LG') },
  };
}
