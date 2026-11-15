# DeckDam

Busca una carta de Pokémon TCG legal en Standard y descubre **en qué mazos competitivos encaja**:
qué arquetipos la juegan, en qué porcentaje de sus listas y con cuántas copias.

- **Cartas:** [TCGdex](https://tcgdex.dev), una API gratuita y sin clave con todas las expansiones, en inglés y español.
- **Mazos:**
  - **Limitless (internacional)** — [limitlesstcg.com/decks](https://limitlesstcg.com/decks): hasta 30
    arquetipos del **formato vigente** y las 6 listas más recientes de cada uno (Regionales, Internacionales, Worlds).
  - **City League JP** — [limitlesstcg.com/tournaments/jp](https://limitlesstcg.com/tournaments/jp): torneos japoneses
    de los últimos 14 días (contados desde el más reciente) y las listas de su top 8, ya traducidas al inglés por
    Limitless. El arquetipo se toma de los íconos de la lista: si coinciden con un arquetipo de Limitless internacional
    se usa ese nombre, si no se arma con los Pokémon del mazo.
  - **Pokedata** — [pokedata.ovh/standings](https://www.pokedata.ovh/standings): torneos oficiales Play! Pokémon
    (Regionales, Internacionales, Worlds), categoría Masters, desde el inicio del formato vigente (la lista más antigua
    del formato vigente en Limitless). Se toma el top 64 de cada torneo con su récord. Los torneos que aún no publicaron
    listas se saltean y entran solos en un scraping posterior. Como el JSON no trae nombre de mazo, el arquetipo se
    **clasifica** comparando los Pokémon de la lista con los arquetipos de Limitless y City League JP
    ([scraper/classify.js](scraper/classify.js)). Las listas que Limitless ya tiene (misma persona y torneo) no se duplican.
  - **Pokecabook** — índices de arquetipos del meta japonés: [archives/1417](https://pokecabook.com/archives/1417)
    (meta principal, "環境デッキレシピまとめ") y [archives/6132](https://pokecabook.com/archives/6132) (otros arquetipos). Por cada arquetipo del índice se toman los 6 mazos más recientes
    **del formato vigente** (la sección actual del artículo, ej. "30th CELEBRATION環境"); los artículos sin mazos del
    formato vigente se omiten. Se leen sus códigos oficiales (pokemon-card.com) y cada carta se traduce al inglés con
    la base de cartas japonesas de Limitless.
    Además lee la recopilación diaria de ganadores de Gym Battle ([archives/27265](https://pokecabook.com/archives/27265)),
    donde aparecen primero los mazos con cartas nuevas; cada mazo toma su arquetipo del subtítulo que lo encabeza
    (`POKECABOOK_DAILY` para cambiar o agregar recopilaciones).

## Idioma y precios

- **Idioma:** la interfaz está en **inglés por defecto**, con un selector EN / ES en la barra superior (se recuerda en el
  navegador). El mismo selector cambia el idioma de las cartas (nombres y textos de TCGdex). Los textos están en
  `public/i18n.js`; `?lang=es` en la URL abre la página en español.
- **Tema claro / oscuro:** botón ☀️/🌙 en la barra superior. Oscuro por defecto (la identidad negro/bordó); la elección
  se recuerda en el navegador. `?theme=light` en la URL abre la página en modo claro.
- **Precio:** la vista de cada carta muestra el precio de **TCGplayer en USD** (precio de mercado y mínimo, por versión:
  normal, holo, reverse holo), con la fecha del dato y un link al producto. El dato viene de TCGdex.

## Se juega junto a (compañeras)

La vista de cada carta muestra hasta 6 cartas que suelen acompañarla: presentes en al menos el 40% de sus listas y al
menos 1,5 veces más comunes ahí que en el meta general. Se descartan las staples genéricas (presentes en el 45% o más
de todas las listas, como Boss's Orders, Ultra Ball, Poké Pad o Fezandipiti ex), las energías básicas y las otras
versiones de la misma carta. Umbrales ajustables con `PARTNER_STAPLE`, `PARTNER_MIN_RATE` y `PARTNER_MIN_LIFT`.

## Cartas solo de Japón

Las cartas que ya se juegan en Japón pero todavía no salieron en inglés (ej. Mega Heatran ex) aparecen en la búsqueda
en una sección propia. Su vista muestra el texto traducido de la carta japonesa (ficha de Limitless con
`?translate=en`, [jpcard.js](jpcard.js)) y su legalidad en el Standard japonés. Para las impresiones japonesas que sí
tienen versión internacional se usan los ataques oficiales en inglés, así cuentan como la misma carta.

## Sprites de los mazos

Cada mazo muestra el sprite de su Pokémon principal (hasta 2), como Limitless. Las fuentes que no los traen
(Pokecabook y Pokedata, cuando el arquetipo no coincide con uno de Limitless) los calculan a partir del nombre del
arquetipo con el formato de Limitless (`kangaskhan-mega`, `exeggutor-alola`, `ogerpon-wellspring`…) en
[scraper/sprites.js](scraper/sprites.js). Si una forma nueva todavía no tiene sprite (ej. Mega Heatran), se usa el de la
especie base. Los sprites verificados quedan en `data/sprites.json`.

Los mazos con arquetipo de un solo nombre (ej. "Dragapult ex") muestran además su **acompañante**: de las combinaciones
conocidas del meta (arquetipos "X / Y" que aparecen en al menos 2 mazos) se toma la que la lista realmente lleva, con
más copias. Las cartas de soporte genéricas (en el 30% o más de todas las listas, como Meowth ex o Fezandipiti ex) no
cuentan como acompañante (`COMPANION_MAX_GLOBAL`, `COMPANION_MIN_PAIRS`).

## Familias de arquetipos

La galería agrupa los arquetipos en familias según su Pokémon principal ([family.js](family.js)): por ejemplo, "Dragapult"
junta Dragapult ex, Dragapult ex / Dudunsparce ex, Dragapult ex / Blaziken ex, etc. Al elegir una familia aparece una
segunda fila con sus variantes para filtrar más fino. Los arquetipos sin Pokémon en el nombre (Basic Box, Festival Lead)
forman su propia familia.

## SEO

- Metaetiquetas de la portada: título, descripción, URL canónica, Open Graph y Twitter (vista previa al compartir el link,
  con `public/og-image.png` de 1200×630) y datos estructurados JSON-LD (`WebApplication`).
- `/robots.txt` y `/sitemap.xml` generados por el servidor (la API queda excluida de los buscadores).
- Título y descripción dinámicos por vista (búsqueda, carta, galería), en inglés y español.
- **`SITE_URL`**: al publicar la app, definí la URL pública (ej. `SITE_URL=https://deckdam.app npm start`) para que la
  canónica, el sitemap y las imágenes de Open Graph apunten al dominio correcto. Sin ella se usa la dirección del pedido.
- Limitación: las vistas internas usan rutas con `#`, que los buscadores no indexan; solo se posiciona la portada.

## Sobre este repositorio

Este repositorio publica la **base** de DeckDam: servidor, scrapers, identidad de cartas, familias de arquetipos y
recursos compartidos. La interfaz (`public/index.html` y `public/styles.css`) y los datos descargados (`data/`) no se
incluyen. Ver [LICENSE](LICENSE): todos los derechos reservados.

## Despliegue gratis: Vercel + GitHub Actions

- **Vercel** sirve la interfaz como estático (`dist/`, armado por `scripts/build-static.mjs`) y la API como una función
  (`api/index.js`, la misma app de `server.js`). La función lee los mazos de **Vercel Blob** y revalida cada 5 minutos.
- **GitHub Actions** (`.github/workflows/scrape.yml`) corre el scraper cada 12 horas y sube `data/decks.json` a Blob
  con `scripts/blob.mjs`. La caché del scraper se guarda entre ejecuciones con `actions/cache`.
- El frontend no está en GitHub, así que **se publica desde la PC** con la CLI de Vercel (`.vercelignore` define qué se
  sube). No conectes el repositorio de GitHub al proyecto de Vercel: publicaría una versión sin interfaz.

Pasos (una sola vez):
1. `npx vercel` → iniciar sesión y crear el proyecto. Después, `npx vercel --prod` para publicar.
2. En el panel de Vercel: **Storage → Create → Blob**, y conectarlo al proyecto (agrega `BLOB_READ_WRITE_TOKEN`).
3. Subir los mazos actuales: `BLOB_READ_WRITE_TOKEN=... node scripts/blob.mjs upload`.
4. En GitHub: **Settings → Secrets and variables → Actions** → secreto `BLOB_READ_WRITE_TOKEN` con el mismo token.
5. Opcional: variable `SITE_URL` en Vercel con el dominio público (para la URL canónica y Open Graph).

Para publicar cambios del frontend: `npx vercel --prod`. Los mazos se actualizan solos.

## Requisitos

Node.js 18 o superior.

## Uso

```bash
npm install
npm run scrape      # descarga los mazos y genera data/decks.json (la primera vez tarda ~10 min)
npm start           # http://localhost:3000
```

### Actualización de mazos

**Automática:** mientras `npm start` está corriendo, el servidor lanza el scraping cada 12 horas
(`SCRAPE_INTERVAL_HOURS`, `0` lo desactiva). Al arrancar, si los datos tienen más de 12 horas, actualiza a los
pocos segundos. Si falla, reintenta en 1 hora y conserva los datos anteriores. El indicador de arriba a la derecha
muestra "Actualizando mazos…" mientras corre; al pasar el mouse se ve la próxima actualización. El progreso queda en
`data/scrape.log`.

**Manual:** `npm run scrape` en cualquier momento. Nunca corren dos scrapings a la vez: si el servidor quiere
actualizar mientras corre uno manual, reintenta 15 minutos después.

En ambos casos el servidor toma los datos nuevos solo, sin reiniciarlo.

### Opciones del scraper

| Comando / variable | Qué hace | Por defecto |
|---|---|---|
| `npm run scrape:limitless` / `scrape:limitless-jp` / `scrape:pokecabook` / `scrape:pokedata` | Actualiza una sola fuente y conserva las demás activas | — |
| `SOURCES` | Fuentes activas, separadas por coma (las demás se quitan de los datos) | `limitless,limitless-jp,pokecabook,pokedata` |
| `POKEDATA_TOP` | Puestos por torneo oficial (top N, Masters) | 64 |
| `POKEDATA_SINCE` | Fecha desde la que se toman torneos oficiales | inicio del formato vigente |
| `CLASSIFY_THRESHOLD` | Similitud mínima para asignar un arquetipo conocido | 0.7 |
| `LIMITLESS_ARCHETYPES` | Arquetipos de Limitless a leer | 30 |
| `LIMITLESS_LISTS` | Listas por arquetipo | 6 |
| `LIMITLESS_JP_DAYS` | Días de torneos japoneses a leer | 14 |
| `LIMITLESS_JP_TOP` | Puestos por torneo japonés (top N) | 8 |
| `POKECABOOK_HUBS` | Índices de Pokecabook a leer (ids de artículo, en orden) | `1417,6132` |
| `POKECABOOK_ARTICLES` | Arquetipos de los índices a leer | 200 (todos) |
| `POKECABOOK_DECKS` | Mazos por arquetipo | 6 |
| `POKECABOOK_ENV` | Sección de formato a usar (se detecta sola) | automática |
| `SCRAPE_DELAY_MS` | Pausa entre peticiones al mismo sitio | 400 |
| `SCRAPE_INTERVAL_HOURS` | Cada cuántas horas actualiza el servidor (0 = nunca) | 12 |

Las páginas descargadas se guardan en `data/cache/`. Las listas y las traducciones no cambian, así que se guardan
para siempre; los índices de mazos se vuelven a descargar cada 12 h. Las traducciones japonés→inglés quedan en
`data/jp-translations.json`.

## Estructura

```
server.js              API Express + archivos estáticos
scraper/
  index.js             orquestador -> data/decks.json
  limitless.js         arquetipos, listas y cartas de Limitless
  pokecabook.js        artículos -> códigos oficiales JP -> cartas
  translate.js         carta JP -> nombre oficial en inglés (vía Limitless)
  http.js              fetch con caché en disco y límite de velocidad por sitio
public/                frontend (HTML/CSS/JS, sin compilación)
```

### API

| Endpoint | Descripción |
|---|---|
| `GET /api/meta` | Totales y fecha de actualización |
| `GET /api/usage?key=mew%20ex%7Cgenome%20hacking` | Arquetipos y listas que usan esa carta exacta, más otras versiones con el mismo nombre |
| `GET /api/decks?source=&archetype=&family=&q=&from=&to=&sort=&limit=&offset=` | Galería de mazos (`from`/`to`: fechas YYYY-MM-DD; `family`: familia de arquetipos; `sort`: `rare` = arquetipos con menos listas primero, `popular` = al revés) |
| `GET /api/decks/:id` | Mazo completo |
| `GET /api/archetypes?source=&from=&to=` | Arquetipos con cantidad de listas (con los mismos filtros) |
| `GET /api/cards` | Cartas distintas presentes en los mazos |

## Cómo se cruzan las cartas

Dos cartas con el mismo nombre pueden ser distintas (ej. varios "Moltres" con ataques diferentes). Por eso cada carta
tiene una **identidad** ([public/cardkey.js](public/cardkey.js)), que comparten el scraper, el servidor y el navegador:

- **Pokémon:** nombre + ataques (o habilidades, si no tiene ataques). Los ataques salen de la ficha de Limitless para
  las cartas de los mazos y de TCGdex para la carta que buscas. Las reimpresiones con el mismo texto cuentan juntas;
  las versiones distintas se muestran aparte, en "Otras versiones".
- **Entrenadores y Energías:** solo el nombre, normalizado (sin acentos, apóstrofos unificados,
  "Basic Psychic Energy" = "Psychic Energy").

Si buscas en español, la app usa los ataques de la versión en inglés de esa misma carta. La búsqueda muestra solo
cartas **legales en Standard** (filtro `legal.standard` de TCGdex, más las expansiones nuevas que TCGdex todavía
no marca como legales, listadas en `STANDARD_EXTRA_SETS` de `public/app.js`; hoy: Delta Reign), sin Pokémon TCG Pocket, y los mazos son solo de
formato Standard. La vista de cada carta muestra su texto completo: habilidades, ataques (costo, daño y efecto),
debilidad, resistencia y retirada.

## Notas

Es un proyecto de fans, sin afiliación con The Pokémon Company, Limitless ni Pokecabook. El scraper va despacio y guarda
lo que descarga para no sobrecargar esos sitios. Si cambia el HTML de alguna fuente, hay que ajustar su parser en `scraper/`.

## Créditos

- Cartas e imágenes de cartas: [TCGdex](https://tcgdex.dev) y [Limitless TCG](https://limitlesstcg.com).
- Mazos: [Limitless TCG](https://limitlesstcg.com), [Pokecabook](https://pokecabook.com/archives/1417) y
  [Pokedata](https://www.pokedata.ovh/standings).
- Símbolos de energía y etiqueta "Ability":
  [“Pokemon SV - SymbolSheet”](https://www.deviantart.com/aschefield/art/Pokemon-SV---SymbolSheet-1164787196)
  por [aschefield](https://www.deviantart.com/aschefield), bajo licencia
  [CC BY-NC-ND 3.0](https://creativecommons.org/licenses/by-nc-nd/3.0/). El archivo
  `public/assets/sv-symbolsheet-aschefield.png` es la hoja original **sin modificar**: la app muestra cada símbolo
  como *sprite* (con CSS), sin recortarla ni editarla. La licencia no permite uso comercial: si la app se
  monetiza, hay que reemplazar estos símbolos o pedir permiso al autor.
- Ícono de energía Dragón (`public/assets/energy-dragon.svg`): esfera de diseño propio, al estilo de la hoja anterior
  (que no incluye Dragón), con el glifo del tipo Dragón redibujado en vector. Las otras hojas del mismo autor que sí
  traen Dragón (SWSH, BWXY) no tienen licencia de uso.
- Pokémon y sus símbolos son marcas de Nintendo / Creatures / GAME FREAK / The Pokémon Company. Proyecto de fans,
  sin fines comerciales y sin afiliación.
