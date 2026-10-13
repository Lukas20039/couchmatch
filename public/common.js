// couchmatch — gemeinsame Helfer für alle Seiten.

const $app = document.getElementById('app');

const GENRE_DE = {
  Action: 'Action', Adventure: 'Abenteuer', Animation: 'Animation', Biography: 'Biografie',
  Comedy: 'Komödie', Crime: 'Krimi', Documentary: 'Doku', Drama: 'Drama', Family: 'Familie',
  Fantasy: 'Fantasy', History: 'Historie', Horror: 'Horror', Music: 'Musik', Musical: 'Musical',
  Mystery: 'Mystery', Romance: 'Romantik', 'Sci-Fi': 'Sci-Fi', Sport: 'Sport',
  Thriller: 'Thriller', War: 'Krieg', Western: 'Western', 'Reality-TV': 'Reality-TV',
  'Talk-Show': 'Talkshow', 'Game-Show': 'Spielshow',
};
const CATEGORY_ICON = { popular: '🔥', new: '🆕', toprated: '⭐', classics: '🏛️', hidden: '💎' };
const VOTE = {
  nope: { icon: '✕', label: 'Nope' },
  maybe: { icon: '👀', label: 'Interessant' },
  like: { icon: '♥', label: 'Like' },
  super: { icon: '★', label: 'Super-Like' },
};
const VOTE_WEIGHT = { maybe: 1, like: 2, super: 3 };

// --- Helfer ---------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const genreDe = (g) => GENRE_DE[g] || g;

async function api(path, body) {
  const res = await fetch('/api' + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Fehler ${res.status}`), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

const creds = {
  get: (roomId) => JSON.parse(localStorage.getItem('couchmatch:' + roomId) || 'null'),
  set: (roomId, c) => localStorage.setItem('couchmatch:' + roomId, JSON.stringify(c)),
  clear: (roomId) => localStorage.removeItem('couchmatch:' + roomId),
};

const imdbUrl = (it) => `https://www.imdb.com/title/${it.id}/`;
const justWatchUrl = (it) => `https://www.justwatch.com/at/Suche?q=${encodeURIComponent(it.name)}`;
const youtubeSearch = (it) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(`${it.name} ${it.year || ''} trailer`)}`;

function itemMeta(it) {
  const parts = [it.type === 'series' ? 'Serie' : 'Film', it.yearLabel || it.year];
  if (it.runtime) parts.push(`${it.runtime} Min${it.type === 'series' ? '/Folge' : ''}`);
  return parts.filter(Boolean);
}

function linksHtml(it) {
  return `
    <button class="btn trailer" data-trailer="${esc(it.id)}">▶ Trailer</button>
    <a class="btn" href="${imdbUrl(it)}" target="_blank" rel="noopener">IMDb</a>
    <a class="btn" href="${justWatchUrl(it)}" target="_blank" rel="noopener">Wo streamen?</a>`;
}

function filterSummary(f) {
  if (f.source === 'watchlist') return [`📌 ${f.listTitle || 'Watchlist'} — nur Titel, die schon drauf stehen`];
  const out = [];
  if (f.mood && META?.moods[f.mood]) out.push('Stimmung: ' + META.moods[f.mood].label);
  out.push(f.types.map((t) => (t === 'movie' ? 'Filme' : 'Serien')).join(' & '));
  if (f.categories?.length) out.push(f.categories.map((c) => CATEGORY_ICON[c] + ' ' + (META?.categories[c] || c)).join(', '));
  if (f.genres?.length) out.push('Genres: ' + f.genres.map(genreDe).join(', '));
  if (f.excludeGenres?.length) out.push('Ohne: ' + f.excludeGenres.map(genreDe).join(', '));
  if (f.minRating) out.push(`IMDb ≥ ${f.minRating}`);
  if (f.yearFrom || f.yearTo) out.push(`Jahre ${f.yearFrom || '…'}–${f.yearTo || '…'}`);
  if (f.maxRuntime) out.push(`Filme ≤ ${f.maxRuntime} Min`);
  return out;
}

function openTrailer(it) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="sheet">
      <button class="close" aria-label="Schließen">✕</button>
      <h3 style="margin:4px 0 12px">${esc(it.name)} <span class="sub" style="color:var(--muted)">${esc(it.yearLabel || '')}</span></h3>
      ${it.trailer
        ? `<iframe class="video" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(it.trailer)}?autoplay=1&rel=0&playsinline=1" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>
           <p class="hint"><a href="https://www.youtube.com/watch?v=${encodeURIComponent(it.trailer)}" target="_blank" rel="noopener">Auf YouTube öffnen</a> · <a href="${youtubeSearch(it)}" target="_blank" rel="noopener">Anderen Trailer suchen</a></p>`
        : `<p>Kein Trailer hinterlegt.</p><a class="btn primary" href="${youtubeSearch(it)}" target="_blank" rel="noopener">Auf YouTube suchen</a>`}
      <p style="font-size:14px;color:#ddd">${esc(it.description)}</p>
    </div>`;
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.close')) close();
  });
  document.body.append(ov);
}

async function share(url, text) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'couchmatch', text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link kopiert ✓');
  } catch {
    prompt('Link kopieren:', url);
  }
}

let META = null;
async function loadMeta() {
  META = await api('/meta');
  return META;
}

// --- Router ---------------------------------------------------------------

let routeFn = () => {};
let leaving = [];
const setRoute = (fn) => (routeFn = fn);
// Aufräumen beim Seitenwechsel (Live-Verbindungen, Timer, Listener)
const onLeave = (fn) => leaving.push(fn);
function route() {
  for (const fn of leaving.splice(0)) fn();
  routeFn();
}
function go(path) {
  history.pushState(null, '', path);
  route();
}
window.addEventListener('popstate', route);
// Interne Links ohne Neuladen
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});

function loading(text) {
  $app.innerHTML = `<div class="center-screen"><div><div class="spinner"></div>${esc(text)}</div></div>`;
}

// --- Konto ----------------------------------------------------------------
// ME = Antwort von /api/me: { account, friends, incoming, outgoing, lists, invites, rooms }

let ME = { account: null };
const meListeners = new Set();
let meEs = null;

async function loadMe() {
  try {
    ME = await api('/me');
  } catch {
    ME = { account: null };
  }
  watchMe();
  return ME;
}

// Seiten melden sich hier an, um bei Änderungen (Anfrage, Bewertung …) neu zu zeichnen
function onMe(fn) {
  meListeners.add(fn);
  onLeave(() => meListeners.delete(fn));
}

const refreshMe = debounce(async () => {
  await loadMe();
  for (const fn of meListeners) fn();
  for (const el of document.querySelectorAll('.account-pill')) el.outerHTML = accountPill();
}, 150);

function watchMe() {
  if (!ME.account) {
    meEs?.close();
    meEs = null;
    return;
  }
  if (meEs) return;
  meEs = new EventSource('/api/me/events');
  meEs.onmessage = (e) => JSON.parse(e.data).type === 'changed' && refreshMe();
}

const pendingCount = () => (ME.incoming?.length || 0) + (ME.invites?.length || 0);

function accountPill() {
  if (!ME.account) return `<a class="pill account-pill" href="/login" data-link>Anmelden</a>`;
  const n = pendingCount();
  return `<a class="pill account-pill" href="/konto" data-link>👤 ${esc(ME.account.name)}${n ? `<span class="dot">${n}</span>` : ''}</a>`;
}

function topline(extra = '') {
  return `<div class="topline"><a class="brand" href="/" data-link>couchmatch</a><span class="spacer"></span>${extra}${accountPill()}</div>`;
}

// Einfaches Overlay für Konto-Seiten
function sheet(html) {
  document.querySelector('.overlay')?.remove();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet"><button class="close" aria-label="Schließen">✕</button>${html}</div>`;
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.close') || e.target.closest('[data-close]')) ov.remove();
  });
  document.body.append(ov);
  return ov;
}

const prioLabel = (p) => (p == null ? 'noch offen' : META?.priorities?.[p] || p);

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'gestern' : `vor ${d} Tagen`;
}

export {
  $app, GENRE_DE, CATEGORY_ICON, VOTE, VOTE_WEIGHT, esc, genreDe, api, toast, debounce, creds, imdbUrl,
  justWatchUrl, youtubeSearch, itemMeta, linksHtml, filterSummary, openTrailer, share, META, loadMeta,
  setRoute, onLeave, route, go, loading, ME, loadMe, onMe, accountPill, topline, sheet, prioLabel, timeAgo,
  pendingCount,
};
