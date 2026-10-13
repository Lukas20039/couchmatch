// couchmatch — Frontend ohne Build-Schritt.

import {
  $app, CATEGORY_ICON, VOTE, ME, META, api, creds, debounce, esc, filterSummary, genreDe, go, itemMeta,
  initPush, linksHtml, loadMe, loadMeta, loading, onLeave, onMe, openTrailer, route, setRoute, share, timeAgo,
  toast, topline,
} from './common.js';
import { accountPage, loginPage } from './account.js';
import { adminPage } from './admin.js';
import { watchlistPage } from './watchlist.js';

setRoute(() => {
  const p = location.pathname;
  let m;
  if ((m = p.match(/^\/r\/([A-Za-z0-9]+)/))) roomPage(m[1]);
  else if ((m = p.match(/^\/w\/(\d+)/))) watchlistPage(Number(m[1]));
  else if (p === '/konto') accountPage();
  else if (p === '/login') loginPage();
  else if (p === '/admin') adminPage();
  else setupPage();
});

// --- Setup ----------------------------------------------------------------

const BASE_EXCLUDES = ['Reality-TV', 'Talk-Show', 'Game-Show'];

const DEFAULT_SETUP = {
  mood: null,
  types: ['movie', 'series'],
  categories: ['popular', 'toprated'],
  genres: [],
  excludeGenres: BASE_EXCLUDES,
  minRating: 6.5,
  yearFrom: '',
  yearTo: '',
  maxRuntime: '',
  count: 50,
  superLimit: 3,
  vetoLimit: 1,
  invite: [],
  excludeWatched: true,
};

async function setupPage() {
  loading('Lade Datenbank …');
  try {
    await loadMeta();
  } catch (err) {
    $app.innerHTML = `<div class="center-screen">${esc(err.message)}</div>`;
    return;
  }
  if (!META.catalog.ready) {
    const p = META.catalog.progress;
    loading(`Die Film-Datenbank wird beim ersten Start aufgebaut … ${p.total ? Math.round((p.done / p.total) * 100) : 0} %`);
    const t = setTimeout(setupPage, 2000);
    onLeave(() => clearTimeout(t));
    return;
  }

  const s = { ...DEFAULT_SETUP, ...JSON.parse(localStorage.getItem('couchmatch:setup') || '{}') };
  let name = localStorage.getItem('couchmatch:name') || '';
  const friendIds = () => new Set((ME.friends || []).map((f) => f.id));
  s.invite = (s.invite || []).filter((id) => friendIds().has(id));

  $app.innerHTML = `
    <div class="page">
      ${topline()}
      <div id="invites"></div>
      <h1>Was schauen wir heute?</h1>
      <p class="lead">Stell den Stapel zusammen, schick den Link — ihr swipt beide und seht am Ende, worauf ihr euch einigen könnt.</p>

      <div class="section">
        <h3>Was soll dabei sein?</h3>
        <div class="chips" id="types"></div>
      </div>

      <div class="section">
        <h3>Stimmung</h3>
        <div class="chips" id="moods"></div>
        <p class="hint">Füllt Genres, Bewertung und Länge vor — danach frei anpassbar.</p>
      </div>

      <div class="section">
        <h3>Kategorien</h3>
        <div class="chips" id="cats"></div>
        <p class="hint">Mehrfachauswahl. Keine Auswahl = alles aus der Datenbank.</p>
      </div>

      <div class="section">
        <h3>Genres</h3>
        <div class="chips" id="genres"></div>
        <p class="hint">Antippen = rein, nochmal antippen = ausschließen, ein drittes Mal = egal.</p>
      </div>

      <div class="section">
        <h3>Feinschliff</h3>
        <div class="field">
          <label for="rating">Mindest-Bewertung (IMDb): <b id="ratingVal"></b></label>
          <input type="range" id="rating" min="0" max="9" step="0.5" />
        </div>
        <div class="row" style="margin-top:14px">
          <div class="field"><label for="yearFrom">Jahr von</label><input class="input" id="yearFrom" type="number" inputmode="numeric" placeholder="z. B. 1990" /></div>
          <div class="field"><label for="yearTo">Jahr bis</label><input class="input" id="yearTo" type="number" inputmode="numeric" placeholder="heute" /></div>
          <div class="field"><label for="runtime">Filmlänge</label>
            <select class="input" id="runtime">
              <option value="">egal</option><option value="90">≤ 90 Min</option>
              <option value="120">≤ 2 Std</option><option value="150">≤ 2,5 Std</option>
            </select>
          </div>
        </div>
      </div>

      <div class="section">
        <h3>Wie viele Titel?</h3>
        <div class="chips" id="counts"></div>
        <div class="row" style="margin-top:10px">
          <div class="field" style="max-width:140px"><input class="input" id="count" type="number" min="1" max="200" inputmode="numeric" /></div>
          <span class="hint" style="margin:0">zufällig aus dem Pool</span>
        </div>
      </div>

      <div class="section">
        <h3>Super-Likes pro Person</h3>
        <div class="chips" id="supers"></div>
      </div>

      <div class="section">
        <h3>Veto-Joker pro Person</h3>
        <div class="chips" id="vetos"></div>
        <p class="hint">Mit einem Veto streicht man einen Match für alle — „den schau ich sicher nicht".</p>
      </div>

      <div class="section" id="who"></div>

      <div id="sample" class="strip"></div>
    </div>
    <div class="sticky-cta"><div class="inner">
      <div class="pool-info" id="pool"></div>
      <button class="btn primary block" id="create">Session erstellen & Link teilen</button>
    </div></div>`;

  const q = (id) => document.getElementById(id);
  const chip = (label, cls, attrs = '') => `<button type="button" class="chip ${cls}" ${attrs}>${label}</button>`;

  const persist = () => localStorage.setItem('couchmatch:setup', JSON.stringify(s));

  function renderChips() {
    q('moods').innerHTML = Object.entries(META.moods)
      .map(([k, m]) => chip(esc(m.label), s.mood === k ? 'on' : '', `data-mood="${k}"`))
      .join('');
    q('vetos').innerHTML = [[0, 'keine'], [1, '1'], [2, '2'], [3, '3']]
      .map(([n, l]) => chip(l, Number(s.vetoLimit) === n ? 'on' : '', `data-veto="${n}"`))
      .join('');
    q('types').innerHTML =
      chip('🎬 Filme', 'big ' + (s.types.includes('movie') ? 'on' : ''), 'data-type="movie"') +
      chip('📺 Serien', 'big ' + (s.types.includes('series') ? 'on' : ''), 'data-type="series"');
    q('cats').innerHTML = Object.entries(META.categories)
      .map(([k, label]) => chip(`${CATEGORY_ICON[k] || ''} ${esc(label)}`, s.categories.includes(k) ? 'on' : '', `data-cat="${k}"`))
      .join('');
    q('genres').innerHTML = META.genres
      .map((g) => chip(esc(genreDe(g)), s.genres.includes(g) ? 'on' : s.excludeGenres.includes(g) ? 'off' : '', `data-genre="${esc(g)}"`))
      .join('');
    q('counts').innerHTML = [5, 10, 20, 30, 50, 100]
      .map((n) => chip(String(n), Number(s.count) === n ? 'on' : '', `data-count="${n}"`))
      .join('');
    q('supers').innerHTML = [[1, '1'], [3, '3'], [5, '5'], [0, 'unbegrenzt']]
      .map(([n, l]) => chip(l, Number(s.superLimit) === n ? 'on' : '', `data-super="${n}"`))
      .join('');
    q('ratingVal').textContent = s.minRating ? `${s.minRating}+` : 'egal';
    if (ME.account) {
      q('friendChips').innerHTML = (ME.friends || [])
        .map((f) => chip(`👤 ${esc(f.name)}`, s.invite.includes(f.id) ? 'on' : '', `data-invite="${f.id}"`))
        .join('') || `<a class="chip" href="/konto" data-link>+ Jemanden verbinden</a>`;
      q('seenChip').innerHTML = chip('🙈 Schon Gesehenes ausblenden', s.excludeWatched ? 'on' : '', 'data-seen="1"');
    }
  }

  // Angemeldet: Mitschauer:innen direkt einladen statt Namen eintippen
  function renderWho() {
    q('who').innerHTML = ME.account
      ? `<h3>Wer schaut mit?</h3>
         <div class="chips" id="friendChips"></div>
         <p class="hint">Ausgewählte bekommen die Einladung direkt in ihr Konto — der Link funktioniert trotzdem für alle.</p>
         <div class="chips" id="seenChip" style="margin-top:12px"></div>
         <p class="hint">Blendet Titel aus, die du (oder die Eingeladenen) in einer Watchlist als gesehen markiert habt.</p>`
      : `<h3>Dein Name</h3>
         <input class="input" id="name" maxlength="24" placeholder="z. B. Lukas" autocomplete="given-name" />
         <p class="hint"><a href="/login" data-link>Mit Konto</a> könnt ihr euch direkt einladen und Matches in einer gemeinsamen Watchlist sammeln.</p>`;
    if (!ME.account) {
      q('name').value = name;
      q('name').addEventListener('input', (e) => {
        name = e.target.value.trim();
        localStorage.setItem('couchmatch:name', name);
      });
    }
  }

  function renderInvites() {
    q('invites').innerHTML = (ME.invites || [])
      .map((inv) => `
        <div class="invite-banner">
          <span>🍿 <b>${esc(inv.from.name)}</b> lädt dich zu einer Session ein (${inv.room.count} Titel, ${timeAgo(inv.at)})</span>
          <a class="btn small primary" href="/r/${esc(inv.roomId)}" data-link>Mitmachen</a>
        </div>`)
      .join('');
  }

  q('rating').value = s.minRating || 0;
  q('yearFrom').value = s.yearFrom;
  q('yearTo').value = s.yearTo;
  q('runtime').value = s.maxRuntime;
  q('count').value = s.count;
  renderWho();
  renderInvites();
  renderChips();
  onMe(() => {
    renderInvites();
    renderChips();
  });

  const filters = () => ({
    mood: s.mood,
    types: s.types,
    categories: s.categories,
    genres: s.genres,
    excludeGenres: s.excludeGenres,
    minRating: s.minRating || null,
    yearFrom: s.yearFrom || null,
    yearTo: s.yearTo || null,
    maxRuntime: s.maxRuntime || null,
  });

  const accountOpts = () => (ME.account ? { invite: s.invite, excludeWatched: s.excludeWatched } : {});

  let available = 0;
  const preview = debounce(async () => {
    try {
      const r = await api('/preview', { filters: filters(), ...accountOpts() });
      if (!q('pool')) return; // Seite inzwischen verlassen (z. B. über eine Einladung)
      available = r.available;
      const n = Math.min(Number(s.count) || 0, available);
      q('pool').innerHTML = available
        ? `<b>${available.toLocaleString('de')}</b> passende Titel (${r.movies} Filme, ${r.series} Serien) — ihr bekommt <b>${n}</b> zufällige`
        : `Mit diesen Filtern bleibt nichts übrig 😕`;
      q('create').disabled = !available;
      q('sample').innerHTML = r.sample.map((i) => `<img src="${esc(i.poster)}" alt="${esc(i.name)}" title="${esc(i.name)}" loading="lazy" />`).join('');
    } catch (err) {
      if (q('pool')) q('pool').textContent = err.message;
    }
  }, 250);

  const changed = () => {
    persist();
    renderChips();
    preview();
  };

  $app.querySelector('.page').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const d = c.dataset;
    if (d.mood) {
      if (s.mood === d.mood) {
        s.mood = null; // abwählen lässt die Filter stehen
      } else {
        const m = META.moods[d.mood];
        s.mood = d.mood;
        s.genres = [...m.genres];
        s.excludeGenres = [...new Set([...BASE_EXCLUDES, ...m.exclude])].filter((g) => !m.genres.includes(g));
        s.minRating = m.minRating || 0;
        s.maxRuntime = m.maxRuntime ? String(m.maxRuntime) : '';
        q('rating').value = s.minRating;
        q('runtime').value = s.maxRuntime;
      }
    } else if (d.veto) {
      s.vetoLimit = Number(d.veto);
    } else if (d.type) {
      const has = s.types.includes(d.type);
      if (has && s.types.length === 1) return toast('Mindestens Filme oder Serien');
      s.types = has ? s.types.filter((t) => t !== d.type) : [...s.types, d.type];
    } else if (d.cat) {
      s.categories = s.categories.includes(d.cat) ? s.categories.filter((x) => x !== d.cat) : [...s.categories, d.cat];
    } else if (d.genre) {
      s.mood = null; // von Hand geändert → keine Vorlage mehr
      const g = d.genre;
      if (s.genres.includes(g)) {
        s.genres = s.genres.filter((x) => x !== g);
        s.excludeGenres = [...s.excludeGenres, g];
      } else if (s.excludeGenres.includes(g)) {
        s.excludeGenres = s.excludeGenres.filter((x) => x !== g);
      } else {
        s.genres = [...s.genres, g];
      }
    } else if (d.count) {
      s.count = Number(d.count);
      q('count').value = s.count;
    } else if (d.super) {
      s.superLimit = Number(d.super);
    } else if (d.invite) {
      const id = Number(d.invite);
      s.invite = s.invite.includes(id) ? s.invite.filter((x) => x !== id) : [...s.invite, id];
    } else if (d.seen) {
      s.excludeWatched = !s.excludeWatched;
    }
    changed();
  });

  q('rating').addEventListener('input', (e) => {
    s.minRating = Number(e.target.value) || 0;
    s.mood = null;
    changed();
  });
  for (const [id, key] of [['yearFrom', 'yearFrom'], ['yearTo', 'yearTo'], ['runtime', 'maxRuntime'], ['count', 'count']]) {
    q(id).addEventListener('input', (e) => {
      s[key] = e.target.value;
      if (key === 'maxRuntime') s.mood = null;
      changed();
    });
  }
  q('create').addEventListener('click', async () => {
    const count = Math.max(1, Math.min(200, Number(s.count) || 50));
    q('create').disabled = true;
    try {
      const r = await api('/rooms', {
        filters: filters(), count, superLimit: s.superLimit, vetoLimit: s.vetoLimit, name: name || 'Ich', ...accountOpts(),
      });
      creds.set(r.roomId, { playerId: r.playerId, token: r.token });
      sessionStorage.setItem('couchmatch:justCreated', r.roomId);
      go('/r/' + r.roomId);
    } catch (err) {
      toast(err.message);
      q('create').disabled = false;
    }
  });

  preview();
}

// --- Session --------------------------------------------------------------

async function roomPage(roomId) {
  loading('Lade Session …');
  if (!META) loadMeta().catch(() => {});
  const c = creds.get(roomId);
  if (!c) return joinPage(roomId);

  let view = null;
  let es = null;
  let closed = false;
  let knownMatches = null;
  const history_ = []; // eigene Stimmen dieser Sitzung, für "Rückgängig"
  const pending = new Map(); // itemId -> Stimme, solange der POST unterwegs ist
  let dragging = false;
  let pendingRender = false;

  onLeave(() => {
    closed = true;
    es?.close();
    document.removeEventListener('keydown', onKey);
  });

  // Konto-Bezug: Watchlists zum Merken, Freunde zum direkten Einladen
  let ctx = { account: false };
  let ctxReady = Promise.resolve();
  let listId = null;
  let listChosen = false;
  async function loadCtx() {
    if (!ME.account) return;
    try {
      ctx = await api(`/rooms/${roomId}/context`);
    } catch {
      return;
    }
    // Der Vorschlag folgt den Mitspieler:innen, bis man selbst eine Liste wählt
    if (!listChosen || !ctx.lists?.some((l) => l.id === listId)) listId = ctx.defaultListId ?? null;
    refreshPins();
    if (liveOpen()) live.refresh();
  }
  const currentList = () => ctx.lists?.find((l) => l.id === listId);
  const pinned = (id) => currentList()?.onList.includes(id);
  onMe(loadCtx);

  async function pin(ids) {
    const list = currentList();
    if (!list) return;
    const todo = ids.filter((id) => !list.onList.includes(id));
    try {
      for (const itemId of todo) {
        await api(`/lists/${list.id}/items`, { itemId, roomId, priority: 2 });
        list.onList.push(itemId);
      }
      toast(todo.length === 1 ? `📌 Auf „${list.title}" gemerkt` : `📌 ${todo.length} Titel auf „${list.title}" gemerkt`);
    } catch (err) {
      toast(err.message);
    }
    if (liveOpen()) live.refresh();
  }

  const pinBtn = (id) =>
    !ctx.account
      ? ''
      : pinned(id)
        ? `<button class="btn pin on" disabled>✓ Gemerkt</button>`
        : `<button class="btn pin" data-pin="${esc(id)}">📌 Merken</button>`;

  function connect() {
    es = new EventSource(`/api/rooms/${roomId}/events?playerId=${encodeURIComponent(c.playerId)}&token=${encodeURIComponent(c.token)}`);
    es.onmessage = (e) => {
      const next = JSON.parse(e.data);
      // Lokale (optimistische) Stimmen behalten, bis der Server sie bestätigt
      for (const [id, v] of pending) {
        if (v === null) delete next.me.votes[id];
        else next.me.votes[id] = v;
      }
      onState(next);
    };
    es.onerror = async () => {
      if (closed || es.readyState !== EventSource.CLOSED) return; // Browser verbindet selbst neu
      try {
        const ctrl = new AbortController();
        const res = await fetch(es.url, { signal: ctrl.signal });
        ctrl.abort();
        if (res.status === 403 || res.status === 404) {
          creds.clear(roomId);
          if (res.status === 404) return notFound();
          return joinPage(roomId);
        }
      } catch {
        // offline — einfach später erneut
      }
      setTimeout(() => !closed && connect(), 2000);
    };
  }

  function notFound() {
    $app.innerHTML = `<div class="center-screen"><div><div style="font-size:48px">🤷</div><p>Diese Session gibt es nicht (mehr).</p><a class="btn primary" href="/">Neue Session starten</a></div></div>`;
  }

  function onState(next) {
    const first = !view;
    // Neue Mitspieler:innen können die passende Paar-Watchlist ändern
    if (first || next.players.length !== view.players.length) ctxReady = loadCtx();
    view = next;
    if (knownMatches && !first) {
      const fresh = view.matches.filter((m) => !knownMatches.has(m.id));
      // Ist die Match-Liste offen, nur kurz Bescheid geben statt sie zu überdecken
      if (fresh.length && liveOpen()) toast(`💘 Neuer Match: ${itemById(fresh[0].id).name}`);
      else if (fresh.length) showMatch(fresh[0]);
    }
    // Merken statt ersetzen, damit ein zurückgenommenes Veto nicht erneut "It's a Match!" auslöst
    knownMatches = new Set([...(knownMatches || []), ...view.matches.map((m) => m.id)]);
    if (!first) notifyFinal(prevFinal, view.final);
    prevFinal = view.final;
    if (first) {
      buildShell();
      if (sessionStorage.getItem('couchmatch:justCreated') === roomId) {
        sessionStorage.removeItem('couchmatch:justCreated');
        ctxReady.finally(showInvite); // erst mit Konto-Kontext, damit "Direkt einladen" dabei ist
      }
    }
    render();
    if (liveOpen()) live.refresh();
  }

  let prevFinal = null;
  function notifyFinal(before, after) {
    if (!before && after) {
      toast('🏆 Das Finale hat begonnen!');
      if (!remaining().length && !liveOpen('final')) showFinal();
    } else if (after?.winner && !before?.winner && !liveOpen('final')) {
      toast(`🏆 Gewinner: ${itemById(after.winner).name}`);
    }
  }

  const myVotes = () => view.me.votes;
  const remaining = () => view.items.filter((i) => !(i.id in myVotes()));
  const others = () => view.players.filter((p) => p.id !== view.me.id);
  const superLeft = () =>
    view.superLimit ? view.superLimit - Object.values(myVotes()).filter((v) => v === 'super').length : Infinity;
  const inviteUrl = () => `${location.origin}/r/${roomId}`;
  const itemById = (id) => view.items.find((i) => i.id === id);

  function buildShell() {
    $app.innerHTML = `
      <div class="swipe">
        <div class="topbar">
          <a class="brand" href="/">couchmatch</a>
          <span class="spacer"></span>
          <button class="pill" id="shareBtn" title="Einladen">🔗 Einladen</button>
          <button class="pill match" id="finalBtn" hidden>🏆</button>
          <button class="pill" id="matchBtn">💘 0</button>
        </div>
        <div class="progress"><div id="bar"></div></div>
        <div class="players" id="players"></div>
        <div id="banner"></div>
        <div class="stack" id="stack"></div>
        <div class="actions">
          <button class="act sm undo" data-act="undo" title="Rückgängig (Backspace)">↶</button>
          <button class="act nope" data-act="nope" title="Nope (←)">✕</button>
          <button class="act sm maybe" data-act="maybe" title="Sieht interessant aus (↓)">👀</button>
          <button class="act super" data-act="super" title="Super-Like (↑)">★<span class="count" id="superCount"></span></button>
          <button class="act like" data-act="like" title="Like (→)">♥</button>
        </div>
        <div class="act-legend"><span class="sm">zurück</span><span>nope</span><span class="sm">vielleicht</span><span>super</span><span>like</span></div>
      </div>`;
    document.getElementById('shareBtn').onclick = showInvite;
    document.getElementById('matchBtn').onclick = showResults;
    document.getElementById('finalBtn').onclick = showFinal;
    $app.querySelector('.actions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'undo') undo();
      else swipeTop(b.dataset.act);
    });
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (document.querySelector('.overlay') || e.target.closest?.('input')) return;
    const map = { ArrowLeft: 'nope', ArrowRight: 'like', ArrowUp: 'super', ArrowDown: 'maybe' };
    if (map[e.key]) {
      e.preventDefault();
      swipeTop(map[e.key]);
    } else if (e.key === 'Backspace') {
      undo();
    }
  }

  function render() {
    if (dragging) {
      pendingRender = true;
      return;
    }
    const total = view.items.length;
    const done = total - remaining().length;
    document.getElementById('bar').style.width = `${total ? (done / total) * 100 : 0}%`;
    const strong = view.matches.length;
    const mb = document.getElementById('matchBtn');
    mb.textContent = `💘 ${strong}`;
    mb.classList.toggle('match', strong > 0);
    document.getElementById('finalBtn').hidden = !view.final;
    document.getElementById('players').innerHTML = view.players
      .map((p) => `<span class="pill">${p.id === view.me.id ? 'Du' : esc(p.name)} · ${Math.min(p.voted, total)}/${total}</span>`)
      .join('');
    const sc = document.getElementById('superCount');
    const left = superLeft();
    sc.textContent = left === Infinity ? '∞' : left;
    sc.parentElement.disabled = left <= 0;
    document.getElementById('banner').innerHTML = others().length
      ? ''
      : `<div class="invite-banner"><span>Noch allein hier — schick den Link an deine:n Mitschauer:in.</span><button class="btn small primary" id="bannerShare">Link teilen</button></div>`;
    document.getElementById('bannerShare')?.addEventListener('click', showInvite);
    renderStack();
  }

  function renderStack() {
    const stack = document.getElementById('stack');
    const rest = remaining();
    const want = rest.slice(0, 3).map((i) => i.id);
    const have = [...stack.querySelectorAll('.card')].map((el) => el.dataset.id).reverse();
    if (want.length && want.join() === have.join()) return;

    if (!rest.length) {
      const waiting = others().filter((p) => p.voted < view.items.length);
      stack.innerHTML = `
        <div class="empty">
          <div class="big">🎉</div>
          <h2 style="margin:0">Durch!</h2>
          <p style="margin:0;color:var(--muted)">${
            !others().length
              ? 'Sobald jemand über deinen Link beitritt, siehst du hier eure Matches.'
              : waiting.length
                ? `${waiting.map((p) => esc(p.name)).join(', ')} swipt noch …`
                : 'Alle sind fertig.'
          }</p>
          <p style="margin:0"><b>${view.matches.length}</b> Match${view.matches.length === 1 ? '' : 'es'} bisher</p>
          <button class="btn primary" id="resultsBtn">💘 Matches ansehen</button>
          ${view.filters.source === 'watchlist' ? '' : '<button class="btn" id="moreBtn">+ 20 weitere Titel</button>'}
        </div>`;
      document.getElementById('resultsBtn').onclick = showResults;
      const moreBtn = document.getElementById('moreBtn');
      if (moreBtn) moreBtn.onclick = async (e) => {
        e.target.disabled = true;
        try {
          const r = await api(`/rooms/${roomId}/more`, { ...c, count: 20 });
          toast(`${r.added} neue Titel für alle hinzugefügt`);
        } catch (err) {
          toast(err.message);
          e.target.disabled = false;
        }
      };
      return;
    }

    stack.innerHTML = '';
    // unterste Karte zuerst, damit die oberste im DOM zuletzt kommt
    for (const id of [...want].reverse()) stack.append(cardEl(itemById(id), id === want[0]));
    const top = stack.lastElementChild;
    attachDrag(top);
  }

  function cardEl(it, isTop) {
    const el = document.createElement('div');
    el.className = 'card' + (isTop ? ' top' : '');
    el.dataset.id = it.id;
    const meta = itemMeta(it).map((m) => `<span class="badge">${esc(m)}</span>`).join('');
    el.innerHTML = `
      <img class="poster" src="${esc(it.poster)}" alt="" draggable="false" />
      <div class="stamp like">Like</div>
      <div class="stamp nope">Nope</div>
      <div class="stamp super">Super</div>
      <div class="stamp maybe">Interessant</div>
      <div class="info">
        <div class="badges">${it.rating ? `<span class="badge rating">IMDb ${it.rating.toFixed(1)}</span>` : ''}${meta}</div>
        <h2>${esc(it.name)}</h2>
        <div class="genres">${it.genres.map(genreDe).map(esc).join(' · ')}</div>
        <p class="desc">${esc(it.description)}</p>
        <div class="credits">
          ${it.director?.length ? `Regie: ${esc(it.director.join(', '))}<br>` : ''}
          ${it.cast?.length ? `Mit: ${esc(it.cast.join(', '))}<br>` : ''}
          ${it.country ? `Land: ${esc(it.country)}` : ''}
        </div>
        <div class="links">${linksHtml(it)}<span class="pin-slot" data-id="${esc(it.id)}">${pinBtn(it.id)}</span></div>
        <div class="more-hint">Antippen für mehr Infos</div>
      </div>`;
    el.querySelector('[data-trailer]').addEventListener('click', () => openTrailer(it));
    el.querySelector('.pin-slot').addEventListener('click', (e) => e.target.closest('[data-pin]') && pin([it.id]).then(refreshPins));
    return el;
  }

  // Karten werden nicht neu gebaut, daher den Merken-Knopf nachträglich aktualisieren
  function refreshPins() {
    for (const slot of document.querySelectorAll('#stack .pin-slot')) slot.innerHTML = pinBtn(slot.dataset.id);
  }

  function stampFor(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'like' : 'nope';
    return dy < 0 ? 'super' : 'maybe';
  }

  function attachDrag(el) {
    let start = null;
    let dx = 0;
    let dy = 0;
    const stamps = Object.fromEntries(['like', 'nope', 'super', 'maybe'].map((k) => [k, el.querySelector('.stamp.' + k)]));

    const setStamp = () => {
      const dir = stampFor(dx, dy);
      const strength = Math.min(1, Math.max(Math.abs(dx), Math.abs(dy)) / 100);
      for (const [k, s] of Object.entries(stamps)) s.style.opacity = k === dir ? strength : 0;
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('a, button') || e.button > 0) return;
      start = { x: e.clientX, y: e.clientY, t: Date.now() };
      dx = dy = 0;
      dragging = true;
      el.setPointerCapture(e.pointerId);
      el.classList.remove('anim');
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      dx = e.clientX - start.x;
      dy = e.clientY - start.y;
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
      setStamp();
    });
    const end = () => {
      if (!start) return;
      const dist = Math.hypot(dx, dy);
      const dt = Date.now() - start.t;
      start = null;
      dragging = false;
      const fast = dist > 40 && dist / dt > 0.6;
      if (dist > 110 || fast) {
        const dir = stampFor(dx, dy);
        if (dir === 'super' && superLeft() <= 0) {
          toast('Keine Super-Likes mehr übrig');
          snapBack();
        } else {
          flyOut(el, dir, dx, dy);
        }
      } else {
        if (dist < 6) el.classList.toggle('expanded');
        snapBack();
      }
      if (pendingRender) {
        pendingRender = false;
        setTimeout(render, 320);
      }
    };
    const snapBack = () => {
      el.classList.add('anim');
      el.style.transform = '';
      for (const s of Object.values(stamps)) s.style.opacity = 0;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function flyOut(el, vote, dx = 0, dy = 0) {
    const id = el.dataset.id;
    const vec = { like: [1, 0], nope: [-1, 0], super: [0, -1], maybe: [0, 1] }[vote];
    const W = window.innerWidth + 200;
    const H = window.innerHeight + 200;
    el.classList.add('anim');
    el.querySelector('.stamp.' + vote).style.opacity = 1;
    el.style.transform = `translate(${vec[0] * W + (vec[0] ? 0 : dx)}px, ${vec[1] * H + (vec[1] ? 0 : dy)}px) rotate(${vec[0] * 30}deg)`;
    el.style.opacity = '0.6';
    el.style.pointerEvents = 'none';
    setTimeout(() => vote_(id, vote), 220);
  }

  function swipeTop(vote) {
    const top = document.querySelector('#stack .card.top');
    if (!top || dragging) return;
    if (vote === 'super' && superLeft() <= 0) return toast('Keine Super-Likes mehr übrig');
    flyOut(top, vote);
  }

  async function vote_(itemId, vote) {
    const prev = myVotes()[itemId];
    myVotes()[itemId] = vote;
    history_.push(itemId);
    pending.set(itemId, vote);
    render();
    try {
      await api(`/rooms/${roomId}/vote`, { ...c, itemId, vote });
    } catch (err) {
      if (prev === undefined) delete myVotes()[itemId];
      else myVotes()[itemId] = prev;
      history_.pop();
      toast(err.message);
      render();
    } finally {
      pending.delete(itemId);
    }
  }

  async function undo() {
    const id = history_.pop();
    if (!id) return toast('Nichts zum Rückgängigmachen');
    const prev = myVotes()[id];
    delete myVotes()[id];
    pending.set(id, null);
    render();
    try {
      await api(`/rooms/${roomId}/vote`, { ...c, itemId: id, vote: null });
    } catch (err) {
      myVotes()[id] = prev;
      history_.push(id);
      toast(err.message);
      render();
    } finally {
      pending.delete(id);
    }
  }

  function overlay(html) {
    document.querySelector('.overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="sheet"><button class="close" aria-label="Schließen">✕</button>${html}</div>`;
    ov.addEventListener('click', (e) => {
      if (e.target === ov || e.target.closest('.close') || e.target.closest('[data-close]')) ov.remove();
      const t = e.target.closest('[data-trailer]');
      if (t) openTrailer(itemById(t.dataset.trailer));
    });
    document.body.append(ov);
    return ov;
  }

  function showInvite() {
    const url = inviteUrl();
    const text = `Lass uns gemeinsam einen Film aussuchen 🍿 Swipe mit mir: ${url}`;
    const ov = overlay(`
      <h2 style="margin:4px 0 6px">Einladen</h2>
      <p style="color:var(--muted);margin:0 0 14px">Schick diesen Link. Wer ihn öffnet, swipt durch dieselben ${view.items.length} Titel.</p>
      <input class="input" readonly value="${esc(url)}" onclick="this.select()" />
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="doShare" style="flex:1">Teilen / Kopieren</button>
        <a class="btn" style="flex:1;background:#25d366;color:#fff" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">WhatsApp</a>
      </div>
      ${ctx.friends?.length ? `
        <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:22px 0 8px">Direkt einladen</h3>
        <div class="chips" id="friendInvites">${ctx.friends
          .map((f) => f.joined
            ? `<span class="chip on">✓ ${esc(f.name)} ist dabei</span>`
            : `<button class="chip" data-friend="${f.id}">👤 ${esc(f.name)}</button>`)
          .join('')}</div>
        <p class="hint">Die Einladung erscheint sofort in ihrem Konto.</p>` : ''}
      <h3 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:22px 0 8px">Diese Session</h3>
      <ul class="summary-list">${filterSummary(view.filters).map((x) => `<li>${esc(x)}</li>`).join('')}<li>${view.items.length} Titel · Super-Likes: ${view.superLimit || 'unbegrenzt'} · Veto-Joker: ${view.vetoLimit || 'keine'}</li></ul>
      <button class="btn block" data-close style="margin-top:18px">Los swipen</button>`);
    ov.querySelector('#doShare').onclick = () => share(url, 'Lass uns gemeinsam einen Film aussuchen 🍿');
    ov.querySelector('#friendInvites')?.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-friend]');
      if (!b) return;
      b.disabled = true;
      try {
        await api(`/rooms/${roomId}/invite`, { friendId: Number(b.dataset.friend) });
        b.textContent = `✉️ ${b.textContent.replace('👤 ', '')} eingeladen`;
        b.classList.add('on');
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
    });
  }

  function voteBadges(m) {
    return view.players
      .map((p) => `${p.id === view.me.id ? 'Du' : esc(p.name)} ${VOTE[m.votes[p.id]]?.icon || ''}`)
      .join(' · ');
  }

  const nameOf = (playerId) =>
    playerId === view.me.id ? 'Du' : esc(view.players.find((p) => p.id === playerId)?.name || '?');
  const myVetoes = () => view.vetoes.filter((v) => v.by === view.me.id).length;
  const vetoesLeft = () => view.vetoLimit - myVetoes();

  function resultRow(it, m, { picked = false, actions = '' } = {}) {
    return `
      <div class="result${picked ? ' picked' : ''}" id="res-${esc(it.id)}">
        <img src="${esc(it.poster)}" alt="" loading="lazy" />
        <div class="meta">
          <h4>${esc(it.name)}${m ? `<span class="tag ${m.strong ? 'strong' : 'weak'}">${m.strong ? 'MATCH' : 'VIELLEICHT'}</span>` : ''}</h4>
          <div class="sub">${[it.rating ? `IMDb ${it.rating.toFixed(1)}` : null, ...itemMeta(it)].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="sub">${it.genres.map(genreDe).map(esc).join(', ')}</div>
          ${m ? `<div class="who">${voteBadges(m)}</div>` : ''}
          <div class="links">${linksHtml(it)}${actions}</div>
        </div>
      </div>`;
  }

  // --- Live-Ansichten: werden bei jedem Server-Update neu gezeichnet --------

  let live = null; // { kind, ov, refresh }
  const liveOpen = (kind) => live && document.body.contains(live.ov) && (!kind || live.kind === kind);

  function openLive(kind, renderFn) {
    const ov = overlay(`<div class="sheet-body"></div>`);
    live = { kind, ov, refresh: () => (ov.querySelector('.sheet-body').innerHTML = renderFn()) };
    live.refresh();
    ov.addEventListener('click', onLiveClick);
    ov.addEventListener('change', (e) => {
      if (e.target.id !== 'listPick') return;
      listId = Number(e.target.value);
      listChosen = true;
      live.refresh();
      refreshPins();
    });
  }

  async function act(path, body) {
    try {
      await api(`/rooms/${roomId}/${path}`, { ...c, ...body });
      return true;
    } catch (err) {
      toast(err.message);
      return false;
    }
  }

  async function onLiveClick(e) {
    if (e.target.closest('[data-trailer]')) return; // Trailer öffnet der Overlay-Handler
    const p = e.target.closest('[data-pin]');
    if (p) {
      p.disabled = true;
      return pin([p.dataset.pin]);
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id, duel } = el.dataset;
    if (action === 'pin-all') {
      el.disabled = true;
      pin(view.matches.filter((m) => m.strong).map((m) => m.id));
    } else if (action === 'invite') showInvite();
    else if (action === 'random') pickRandom();
    else if (action === 'open-final') showFinal();
    else if (action === 'open-results') showResults();
    else if (action === 'veto') {
      el.disabled = true;
      if (await act('veto', { itemId: id })) toast(view.vetoes.some((v) => v.id === id) ? 'Veto eingelegt 🚫' : 'Veto zurückgenommen');
    } else if (action === 'final-start') {
      el.disabled = true;
      if (await act('final', { action: 'start' })) showFinal();
    } else if (action === 'final-reset') {
      if (confirm('Finale für alle zurücksetzen?')) await act('final', { action: 'reset' });
    } else if (action === 'pick') {
      // sofort zum nächsten Duell, der Server bestätigt per Live-Update
      const d = view.final?.rounds.at(-1)?.duels[duel];
      if (!d || d.winner) return;
      d.picks[view.me.id] = id;
      d.picked = [...new Set([...d.picked, view.me.id])];
      live.refresh();
      await act('final', { action: 'pick', duel: Number(duel), itemId: id });
    }
  }

  let resultsPicked = null;

  function pickRandom() {
    const strong = view.matches.filter((m) => m.strong);
    const pool = strong.length ? strong : view.matches;
    const total = pool.reduce((s, m) => s + m.score, 0);
    let r = Math.random() * total;
    const chosen = pool.find((m) => (r -= m.score) < 0) || pool[0];
    resultsPicked = chosen.id;
    live.refresh();
    document.getElementById('res-' + chosen.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(`Heute: ${itemById(chosen.id).name} 🍿`);
  }

  function showResults() {
    resultsPicked = null;
    openLive('results', renderResults);
  }

  function renderResults() {
    const strong = view.matches.filter((m) => m.strong);
    const weak = view.matches.filter((m) => !m.strong);
    const matchedIds = new Set(view.matches.map((m) => m.id));
    const vetoedIds = new Set(view.vetoes.map((v) => v.id));
    const mineOnly = view.items.filter(
      (i) => ['like', 'super'].includes(myVotes()[i.id]) && !matchedIds.has(i.id) && !vetoedIds.has(i.id),
    );
    const canVeto = view.vetoLimit > 0 && !view.final;
    const vetoBtn = (m) =>
      canVeto
        ? `<button class="btn veto" data-action="veto" data-id="${esc(m.id)}" ${vetoesLeft() > 0 ? '' : 'disabled'}>🚫 Veto</button>`
        : '';
    const row = (m) => resultRow(itemById(m.id), m, { picked: m.id === resultsPicked, actions: pinBtn(m.id) + vetoBtn(m) });
    const unpinned = strong.filter((m) => !pinned(m.id));
    const listBlock = ctx.account && view.matches.length
      ? `<div class="list-pick">
           <label>📌 Merken auf
             <select class="input" id="listPick">${ctx.lists
               .map((l) => `<option value="${l.id}" ${l.id === listId ? 'selected' : ''}>${esc(l.title)}</option>`)
               .join('')}</select>
           </label>
           ${unpinned.length > 1 ? `<button class="btn small" data-action="pin-all">Alle ${unpinned.length} Volltreffer merken</button>` : ''}
         </div>`
      : '';

    let finalBlock = '';
    if (view.final?.winner) {
      const w = itemById(view.final.winner);
      finalBlock = `<button class="btn primary block" data-action="open-final">🏆 Finale-Sieger: ${esc(w.name)}</button>`;
    } else if (view.final) {
      finalBlock = `<button class="btn primary block" data-action="open-final">🏆 Zum laufenden Finale</button>`;
    } else if (view.matches.length >= 2) {
      const n = Math.min(8, strong.length >= 2 ? strong.length : view.matches.length);
      finalBlock = `
        <button class="btn primary block" data-action="final-start">🏆 Finale starten (${n} Titel)</button>
        <p class="hint" style="text-align:center">Duelle „Was lieber?", bis einer übrig bleibt — ihr wählt beide.</p>`;
    }

    const body = !others().length
      ? `<p style="color:var(--muted)">Noch niemand beigetreten. Sobald dein:e Mitschauer:in über den Link mitswipt, erscheinen hier eure Matches.</p>
         <button class="btn primary" data-action="invite">🔗 Einladen</button>`
      : !view.matches.length
        ? `<p style="color:var(--muted)">Noch keine Matches. ${remaining().length ? 'Swipe weiter!' : 'Holt euch noch ein paar Titel dazu.'}</p>`
        : `
          ${finalBlock}
          <button class="btn block" data-action="random" style="margin-top:8px">🎲 Zufällig einen Match auswählen</button>
          ${canVeto ? `<p class="hint" style="text-align:center">Veto-Joker: noch ${vetoesLeft()} von ${view.vetoLimit}</p>` : ''}
          ${listBlock}
          ${strong.length ? `<h3 style="margin:20px 0 0">Volltreffer (${strong.length})</h3>${strong.map(row).join('')}` : ''}
          ${weak.length ? `<h3 style="margin:20px 0 0">Vielleicht (${weak.length})</h3><p class="hint">Mindestens eine:r fand's nur „interessant".</p>${weak.map(row).join('')}` : ''}`;

    const vetoed = view.vetoes.length
      ? `<h3 style="margin:20px 0 0">Per Veto gestrichen (${view.vetoes.length})</h3>
         ${view.vetoes
           .map(({ id, by }) => {
             const it = itemById(id);
             const undo = by === view.me.id && !view.final
               ? `<button class="btn" data-action="veto" data-id="${esc(id)}">↶ Zurücknehmen</button>`
               : '';
             return `<div class="result vetoed"><img src="${esc(it.poster)}" alt="" loading="lazy" /><div class="meta"><h4>${esc(it.name)}</h4><div class="sub">🚫 Veto von ${nameOf(by)}</div><div class="links">${undo}</div></div></div>`;
           })
           .join('')}`
      : '';

    return `
      <h2 style="margin:4px 0 4px">💘 Eure Matches</h2>
      <p style="color:var(--muted);margin:0 0 14px">${view.players.map((p) => `${nameOf(p.id)}: ${Math.min(p.voted, view.items.length)}/${view.items.length}`).join(' · ')}</p>
      ${body}
      ${vetoed}
      ${mineOnly.length ? `<details style="margin-top:16px"><summary>Nur du magst (${mineOnly.length})</summary>${mineOnly.map((it) => resultRow(it, null)).join('')}</details>` : ''}`;
  }

  // --- Finale ----------------------------------------------------------------

  const DECIDED = {
    unanimous: 'einstimmig',
    majority: 'Mehrheit',
    score: 'uneinig → höherer Match-Score',
    random: 'uneinig → Münzwurf',
  };

  function showFinal() {
    openLive('final', renderFinal);
  }

  function duelHistory(f) {
    const rows = [];
    f.rounds.forEach((r, ri) => {
      for (const d of r.duels) {
        if (!d.winner) continue;
        const loser = d.winner === d.a ? d.b : d.a;
        const picks = Object.entries(d.picks).map(([p, id]) => `${nameOf(p)}: ${esc(itemById(id).name)}`).join(' · ');
        rows.push(`<li><b>${esc(itemById(d.winner).name)}</b> schlägt ${esc(itemById(loser).name)} <span class="hint">(${DECIDED[d.decidedBy]}${picks ? ' — ' + picks : ''})</span></li>`);
      }
      if (r.bye && ri < f.rounds.length - 1) rows.push(`<li>${esc(itemById(r.bye).name)} <span class="hint">kampflos weiter</span></li>`);
    });
    return rows.length ? `<details style="margin-top:18px"><summary>Bisherige Duelle (${rows.length})</summary><ul class="summary-list">${rows.join('')}</ul></details>` : '';
  }

  function renderFinal() {
    const f = view.final;
    if (!f) return `<p style="color:var(--muted)">Das Finale wurde zurückgesetzt.</p><button class="btn" data-action="open-results">💘 Zu den Matches</button>`;
    const totalRounds = Math.ceil(Math.log2(f.entries.length));

    if (f.winner) {
      const w = itemById(f.winner);
      return `
        <div class="final-winner">
          <div class="trophy">🏆</div>
          <p class="hint" style="margin:0">Heute schauen wir</p>
          <img src="${esc(w.poster)}" alt="" />
          <h2>${esc(w.name)}</h2>
          <div class="sub">${[w.rating ? `IMDb ${w.rating.toFixed(1)}` : null, ...itemMeta(w)].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="links" style="justify-content:center">${linksHtml(w)}${pinBtn(w.id)}</div>
        </div>
        ${duelHistory(f)}
        <div class="row" style="margin-top:18px">
          <button class="btn" style="flex:1" data-action="final-reset">↺ Neues Finale</button>
          <button class="btn" style="flex:1" data-action="open-results">💘 Matches</button>
        </div>`;
    }

    const roundNo = f.rounds.length;
    const round = f.rounds.at(-1);
    const isLast = round.duels.length === 1 && !round.bye;
    const title = isLast ? 'Endspiel' : `Runde ${roundNo} von ${totalRounds}`;
    const myIdx = round.duels.findIndex((d) => !d.winner && !d.picks[view.me.id]);
    const byeNote = round.bye ? `<p class="hint" style="text-align:center">${esc(itemById(round.bye).name)} kommt diese Runde kampflos weiter.</p>` : '';

    let main;
    if (myIdx >= 0) {
      const d = round.duels[myIdx];
      const card = (id) => {
        const it = itemById(id);
        return `
          <button class="duel-card" data-action="pick" data-duel="${myIdx}" data-id="${esc(id)}">
            <img src="${esc(it.poster)}" alt="" />
            <b>${esc(it.name)}</b>
            <span class="sub">${[it.year, it.rating ? `IMDb ${it.rating.toFixed(1)}` : null].filter(Boolean).join(' · ')}</span>
            <span class="btn small trailer" data-trailer="${esc(id)}">▶ Trailer</span>
          </button>`;
      };
      main = `
        <p class="hint" style="text-align:center;margin:0 0 10px">Duell ${myIdx + 1} von ${round.duels.length} — tippe auf deinen Favoriten</p>
        <div class="duel">${card(d.a)}<div class="vs">vs</div>${card(d.b)}</div>`;
    } else {
      const waiting = view.players.filter((p) => round.duels.some((d) => !d.winner && !d.picked.includes(p.id)));
      main = `
        <div class="empty-inline">
          <div class="spinner"></div>
          <p>Du hast gewählt. Warte auf ${waiting.map((p) => esc(p.name)).join(', ') || '…'}</p>
        </div>
        <ul class="summary-list">${round.duels
          .map((d) => `<li>${esc(itemById(d.a).name)} vs ${esc(itemById(d.b).name)} — ${d.winner ? `✓ ${esc(itemById(d.winner).name)}` : `${d.picked.length}/${view.players.length} gewählt`}</li>`)
          .join('')}</ul>`;
    }

    return `
      <h2 style="margin:4px 0 2px">🏆 Finale · ${title}</h2>
      <p style="color:var(--muted);margin:0 0 14px">Was lieber? Bei Uneinigkeit entscheidet der Match-Score, bei Gleichstand eine Münze.</p>
      ${main}
      ${byeNote}
      ${duelHistory(f)}
      <div class="row" style="margin-top:18px">
        <button class="btn small" data-action="open-results">💘 Matches</button>
        <button class="btn small" data-action="final-reset">✕ Finale abbrechen</button>
      </div>`;
  }

  function showMatch(m) {
    const it = itemById(m.id);
    if (!it) return;
    navigator.vibrate?.(80);
    const ov = overlay(`
      <div class="match-pop">
        <h2>It's a Match!</h2>
        <img src="${esc(it.poster)}" alt="" />
        <h3 style="margin:0">${esc(it.name)}</h3>
        <p style="color:var(--muted)">${voteBadges(m)}</p>
        <div class="row" style="justify-content:center">
          <button class="btn" data-trailer="${esc(it.id)}">▶ Trailer</button>
          <button class="btn primary" data-close>Weiter swipen</button>
        </div>
      </div>`);
    ov.querySelector('.close').remove();
  }

  connect();
}

async function joinPage(roomId) {
  loading('Lade Einladung …');
  let info;
  try {
    [info] = await Promise.all([api(`/rooms/${roomId}`), META ? null : loadMeta()]);
  } catch (err) {
    $app.innerHTML = `<div class="center-screen"><div><div style="font-size:48px">🤷</div><p>${esc(err.message)}</p><a class="btn primary" href="/">Eigene Session starten</a></div></div>`;
    return;
  }
  // Mit Konto schon dabei (anderes Gerät) → direkt weiter
  if (info.playerId) {
    creds.set(roomId, { playerId: info.playerId, token: info.token });
    return route();
  }
  const saved = localStorage.getItem('couchmatch:name') || '';
  const next = encodeURIComponent(location.pathname);
  $app.innerHTML = `
    <div class="page">
      ${topline()}
      <h1>${esc(info.host)} lädt dich zum Film-Matchen ein 🍿</h1>
      <p class="lead">Swipe durch ${info.count} Titel: ♥ Like, ★ Super-Like, 👀 „sieht interessant aus" oder ✕ Nope. Am Ende seht ihr, worauf ihr euch einigen könnt.</p>
      <div class="card-panel">
        <ul class="summary-list">${filterSummary(info.filters).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <p class="hint">Dabei: ${info.players.map(esc).join(', ')}</p>
      </div>
      ${ME.account
        ? `<p class="hint" style="margin:22px 0 12px">Du machst mit als <b>${esc(ME.account.name)}</b> — Matches kannst du direkt in eure Watchlist übernehmen.</p>`
        : `<div class="section">
             <h3>Dein Name</h3>
             <input class="input" id="name" maxlength="24" placeholder="z. B. Anna" value="${esc(saved)}" autocomplete="given-name" />
             <p class="hint">Oder <a href="/login?next=${next}" data-link>mit Konto mitmachen</a> — dann landen Matches in eurer gemeinsamen Watchlist.</p>
           </div>`}
      <button class="btn primary block" id="join">Mitmachen</button>
      <p class="hint" style="text-align:center;margin-top:14px">Wischen: → Like · ← Nope · ↑ Super-Like · ↓ Interessant</p>
    </div>`;
  const input = document.getElementById('name');
  const submit = async () => {
    const name = ME.account ? ME.account.name : input.value.trim();
    if (!name) {
      input.focus();
      return toast('Wie heißt du?');
    }
    if (!ME.account) localStorage.setItem('couchmatch:name', name);
    document.getElementById('join').disabled = true;
    try {
      const r = await api(`/rooms/${roomId}/join`, { name });
      creds.set(roomId, { playerId: r.playerId, token: r.token });
      route();
    } catch (err) {
      toast(err.message);
      document.getElementById('join').disabled = false;
    }
  };
  document.getElementById('join').onclick = submit;
  input?.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
}

await loadMe();
route();
initPush();
