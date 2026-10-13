// Lokale Film-/Seriendatenbank, aufgebaut aus dem freien Cinemeta-Katalog
// (Stremio, kein Konto und kein API-Key nötig). Der Crawl läuft beim Start,
// wenn die Datei fehlt oder älter als einen Tag ist, und danach täglich.

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://v3-cinemeta.strem.io';
const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = DAY;

export const GENRES = [
  'Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Musical', 'Mystery',
  'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western', 'Reality-TV', 'Talk-Show',
  'Game-Show',
];

// Kategorien sind ODER-verknüpft: ein Titel kommt in den Pool, wenn er
// mindestens eine der gewählten Kategorien erfüllt.
const known = (it, top, year) =>
  (it.topRank ?? Infinity) < top || (it.yearRank ?? Infinity) < year;

export const CATEGORIES = {
  popular: {
    label: 'Gerade beliebt',
    test: (it) => (it.topRank ?? Infinity) < 400,
  },
  new: {
    label: 'Neu (letzte 12 Monate)',
    test: (it, now) =>
      it.released != null && now - Date.parse(it.released) < 365 * DAY && known(it, 2500, 120),
  },
  toprated: {
    label: 'Top bewertet',
    test: (it) => it.rating >= 7.8 && known(it, 1500, 15),
  },
  classics: {
    label: 'All-time Klassiker',
    test: (it) => it.year != null && it.year < 2000 && it.rating >= 7.4 && known(it, 2000, 20),
  },
  hidden: {
    label: 'Geheimtipps',
    test: (it) =>
      it.rating >= 7.4 && (it.topRank ?? Infinity) >= 1500 && (it.yearRank ?? Infinity) < 150,
  },
};

// Stimmungs-Vorlagen: füllen im Setup Genres, Ausschlüsse, Mindestbewertung
// und Filmlänge vor. Danach lässt sich alles weiter anpassen.
export const MOODS = {
  funny: { label: '😂 Leicht & lustig', genres: ['Comedy', 'Family', 'Animation'], exclude: ['Horror', 'War', 'Documentary'], minRating: 6, maxRuntime: 120 },
  date: { label: '💘 Date Night', genres: ['Romance', 'Comedy'], exclude: ['Horror', 'War', 'Documentary'], minRating: 6.5 },
  thrill: { label: '😱 Nervenkitzel', genres: ['Thriller', 'Horror', 'Mystery'], exclude: ['Family', 'Animation'], minRating: 6.5 },
  action: { label: '💥 Action & Abenteuer', genres: ['Action', 'Adventure', 'Sci-Fi'], exclude: ['Documentary'], minRating: 6.5 },
  crime: { label: '🔎 Krimi-Abend', genres: ['Crime', 'Mystery'], exclude: ['Animation', 'Family'], minRating: 7 },
  brain: { label: '🧠 Was zum Nachdenken', genres: ['Drama', 'Sci-Fi', 'Mystery', 'Biography', 'History'], exclude: ['Family', 'Animation'], minRating: 7.5 },
  feels: { label: '😢 Zum Mitfühlen', genres: ['Drama', 'Romance', 'Biography'], exclude: ['Horror', 'Action'], minRating: 7 },
  chill: { label: '🛋️ Hirn aus', genres: ['Action', 'Comedy', 'Animation', 'Adventure'], exclude: ['Documentary', 'Biography', 'History', 'War'], minRating: 5.5, maxRuntime: 120 },
  docs: { label: '🌍 Doku-Abend', genres: ['Documentary'], exclude: [], minRating: 7 },
};

let state = { updatedAt: 0, items: [] };
let syncing = null;
let progress = { done: 0, total: 0 };

export function catalogStatus() {
  return {
    ready: state.items.length > 0,
    count: state.items.length,
    updatedAt: state.updatedAt || null,
    syncing: syncing != null,
    progress,
  };
}

export function allItems() {
  return state.items;
}

function file(dataDir) {
  return path.join(dataDir, 'catalog.json');
}

export async function loadCatalog(dataDir, log = console) {
  try {
    state = JSON.parse(await fs.readFile(file(dataDir), 'utf8'));
    log.info?.(`Katalog geladen: ${state.items.length} Titel`);
  } catch {
    state = { updatedAt: 0, items: [] };
  }
  if (Date.now() - state.updatedAt > MAX_AGE) syncCatalog(dataDir, log);
  setInterval(() => syncCatalog(dataDir, log), MAX_AGE).unref();
}

export function syncCatalog(dataDir, log = console) {
  if (syncing) return syncing;
  syncing = crawl(log)
    .then(async (items) => {
      if (items.length < 500) throw new Error(`nur ${items.length} Titel geladen, behalte alten Stand`);
      state = { updatedAt: Date.now(), items };
      await fs.mkdir(dataDir, { recursive: true });
      const tmp = file(dataDir) + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(state));
      await fs.rename(tmp, file(dataDir));
      log.info?.(`Katalog aktualisiert: ${items.length} Titel`);
    })
    .catch((err) => log.error?.('Katalog-Sync fehlgeschlagen:', err.message))
    .finally(() => {
      syncing = null;
    });
  return syncing;
}

async function fetchJson(url, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i + 1 >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

export function normalize(m, type) {
  const id = m.imdb_id || m.id;
  if (!id || !/^tt\d+$/.test(id) || !m.name || !m.poster) return null;
  const year = parseInt(String(m.releaseInfo || m.year || '').slice(0, 4), 10) || null;
  const trailer =
    m.trailerStreams?.[0]?.ytId ||
    m.trailers?.find((t) => t.type === 'Trailer')?.source ||
    m.trailers?.[0]?.source ||
    null;
  return {
    id,
    type,
    name: m.name,
    year,
    yearLabel: m.releaseInfo || (year ? String(year) : ''),
    released: m.released || null,
    genres: Array.isArray(m.genres) ? m.genres : Array.isArray(m.genre) ? m.genre : [],
    rating: parseFloat(m.imdbRating) || null,
    runtime: parseInt(m.runtime, 10) || null,
    description: m.description || '',
    poster: m.poster.replace('/poster/small/', '/poster/medium/'),
    trailer,
    cast: Array.isArray(m.cast) ? m.cast.slice(0, 4) : [],
    director: Array.isArray(m.director) ? m.director.slice(0, 2) : [],
    country: m.country || null,
    topRank: null,
    yearRank: null,
  };
}

async function crawl(log) {
  const items = new Map();
  const add = (m, type, field, rank) => {
    const n = normalize(m, type);
    if (!n) return;
    const existing = items.get(n.id);
    if (!existing) {
      n[field] = rank;
      items.set(n.id, n);
    } else if (existing[field] == null || rank < existing[field]) {
      existing[field] = rank;
    }
  };

  const jobs = [
    { type: 'movie', catalog: 'top', extra: [], pages: 60, field: 'topRank' },
    { type: 'series', catalog: 'top', extra: [], pages: 40, field: 'topRank' },
  ];
  const now = new Date().getFullYear();
  for (let y = now; y >= 1950; y--) {
    jobs.push({ type: 'movie', catalog: 'year', extra: [`genre=${y}`], pages: y >= 1980 ? 3 : 2, field: 'yearRank' });
    if (y >= 1970) jobs.push({ type: 'series', catalog: 'year', extra: [`genre=${y}`], pages: 2, field: 'yearRank' });
  }

  progress = { done: 0, total: jobs.length };
  log.info?.(`Katalog-Sync startet (${jobs.length} Listen) …`);

  const runJob = async (job) => {
    let rank = 0;
    for (let p = 0; p < job.pages; p++) {
      const extra = [...job.extra, ...(p ? [`skip=${p * 50}`] : [])].join('&');
      const url = `${BASE}/catalog/${job.type}/${job.catalog}${extra ? '/' + extra : ''}.json`;
      let metas;
      try {
        metas = (await fetchJson(url)).metas || [];
      } catch (err) {
        log.warn?.(`  ${url}: ${err.message}`);
        break;
      }
      for (const m of metas) add(m, job.type, job.field, rank++);
      if (metas.length < 20) break;
    }
    progress.done++;
  };

  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) await runJob(queue.shift());
    }),
  );
  return [...items.values()];
}

// Filter aus dem Setup-Formular. Unbekannte Felder werden ignoriert,
// alles wird auf sinnvolle Werte begrenzt.
export function sanitizeFilters(f = {}) {
  const types = ['movie', 'series'].filter((t) => f.types?.includes?.(t));
  const pickGenres = (list) =>
    Array.isArray(list) ? [...new Set(list.filter((g) => GENRES.includes(g)))] : [];
  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' && v != null ? Math.min(max, Math.max(min, n)) : null;
  };
  return {
    mood: f.mood in MOODS ? f.mood : null, // nur zur Anzeige, die Filter selbst stehen unten
    types: types.length ? types : ['movie'],
    categories: Array.isArray(f.categories) ? f.categories.filter((c) => c in CATEGORIES) : [],
    genres: pickGenres(f.genres),
    excludeGenres: pickGenres(f.excludeGenres),
    minRating: num(f.minRating, 0, 10) || null,
    yearFrom: num(f.yearFrom, 1900, 2100),
    yearTo: num(f.yearTo, 1900, 2100),
    maxRuntime: num(f.maxRuntime, 30, 600),
  };
}

export function filterItems(items, f, now = Date.now()) {
  const cats = f.categories.map((c) => CATEGORIES[c]);
  return items.filter((it) => {
    if (!f.types.includes(it.type)) return false;
    if (it.released && Date.parse(it.released) > now) return false; // noch nicht erschienen
    if (it.type === 'movie' && it.runtime && it.runtime < 40) return false; // Kurzfilme
    if (f.minRating && !(it.rating >= f.minRating)) return false;
    if (f.yearFrom && !(it.year >= f.yearFrom)) return false;
    if (f.yearTo && !(it.year <= f.yearTo)) return false;
    if (f.maxRuntime && it.type === 'movie' && !(it.runtime && it.runtime <= f.maxRuntime)) return false;
    if (f.genres.length && !f.genres.some((g) => it.genres.includes(g))) return false;
    if (f.excludeGenres.some((g) => it.genres.includes(g))) return false;
    if (cats.length && !cats.some((c) => c.test(it, now))) return false;
    return true;
  });
}

export function sample(list, count) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const index = new WeakMap(); // items-Array -> { byId, names }

function indexFor(items) {
  let ix = index.get(items);
  if (!ix) {
    ix = { byId: new Map(items.map((i) => [i.id, i])), names: items.map((i) => fold(i.name)) };
    index.set(items, ix);
  }
  return ix;
}

export function findItem(id, items = state.items) {
  return indexFor(items).byId.get(id) || null;
}

// Titelsuche für die Watchlist: exakt vor Wortanfang vor irgendwo, dann nach Bekanntheit
export function searchItems(query, limit = 20, items = state.items) {
  const q = fold(query);
  if (q.length < 2) return [];
  const { names } = indexFor(items);
  const hits = [];
  for (let i = 0; i < items.length; i++) {
    const n = names[i];
    const at = n.indexOf(q);
    if (at < 0) continue;
    const rank = n === q ? 0 : at === 0 ? 1 : /[^a-z0-9]/.test(n[at - 1]) ? 2 : 3;
    const fame = Math.min(items[i].topRank ?? 1e9, (items[i].yearRank ?? 1e8) * 10);
    hits.push({ it: items[i], rank, fame });
  }
  hits.sort((a, b) => a.rank - b.rank || a.fame - b.fame);
  return hits.slice(0, limit).map((h) => toCard(h.it));
}

// Was in einer Session landet — ohne interne Ranking-Felder.
export function toCard(it) {
  const { topRank, yearRank, ...card } = it;
  return card;
}
