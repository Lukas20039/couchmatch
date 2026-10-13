// couchmatch — Konto-Seiten: Anmeldung, Konto (Freunde, Einladungen) und Watchlists.

import {
  $app, ME, META, api, creds, debounce, esc, genreDe, go, itemMeta, linksHtml, loadMe, loadMeta, loading, onLeave, onMe,
  openTrailer, prioLabel, share, sheet, timeAgo, toast, topline,
} from './common.js';

// Nur interne Pfade als Rücksprungziel zulassen
const nextPath = () => {
  const n = new URLSearchParams(location.search).get('next') || '';
  return n.startsWith('/') && !n.startsWith('//') ? n : null;
};

function needLogin() {
  if (ME.account) return false;
  history.replaceState(null, '', `/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  loginPage();
  return true;
}

const h3 = (text) => `<h3 class="sec-title">${text}</h3>`;

// --- Anmelden / Registrieren ----------------------------------------------

export async function loginPage() {
  if (!META) await loadMeta().catch(() => {});
  if (ME.account) return go(nextPath() || '/konto');
  let mode = META?.signup === false ? 'login' : new URLSearchParams(location.search).get('mode') || 'login';

  function render() {
    const reg = mode === 'register';
    $app.innerHTML = `
      <div class="page narrow">
        ${topline()}
        <h1>${reg ? 'Konto anlegen' : 'Anmelden'}</h1>
        <p class="lead">${reg
          ? 'Mit Konto könnt ihr euch gegenseitig anfragen, direkt einladen und eine gemeinsame Watchlist führen.'
          : 'Willkommen zurück 🍿'}</p>
        <form class="card-panel form" id="form" autocomplete="on">
          <div class="field"><label for="u">Benutzername</label>
            <input class="input" id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="24" required placeholder="z. B. lukas" /></div>
          ${reg ? `<div class="field"><label for="n">Anzeigename</label>
            <input class="input" id="n" name="name" autocomplete="given-name" maxlength="24" placeholder="z. B. Lukas" /></div>` : ''}
          <div class="field"><label for="p">Passwort${reg ? ' (mind. 8 Zeichen)' : ''}</label>
            <input class="input" id="p" type="password" name="password" autocomplete="${reg ? 'new-password' : 'current-password'}" minlength="${reg ? 8 : 1}" required /></div>
          <button class="btn primary block" id="submit">${reg ? 'Konto anlegen' : 'Anmelden'}</button>
        </form>
        ${META?.signup === false ? '' : `<p class="hint" style="text-align:center;margin-top:16px">
          ${reg ? 'Schon ein Konto?' : 'Noch kein Konto?'} <a href="#" id="switch">${reg ? 'Anmelden' : 'Jetzt anlegen'}</a></p>`}
        <p class="hint" style="text-align:center">Ohne Konto geht's auch: <a href="/" data-link>einfach eine Session starten</a>.</p>
      </div>`;
    const prevName = localStorage.getItem('couchmatch:name');
    if (reg && prevName) document.getElementById('n').value = prevName;
    document.getElementById('switch')?.addEventListener('click', (e) => {
      e.preventDefault();
      mode = reg ? 'login' : 'register';
      render();
    });
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submit');
      btn.disabled = true;
      const body = {
        username: document.getElementById('u').value.trim(),
        password: document.getElementById('p').value,
        ...(reg && { name: document.getElementById('n').value.trim() }),
      };
      try {
        await api(`/auth/${reg ? 'register' : 'login'}`, body);
        await loadMe();
        toast(reg ? `Willkommen, ${ME.account.name}! 🎉` : `Hallo ${ME.account.name} 👋`);
        go(nextPath() || (reg ? '/konto' : '/'));
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
    document.getElementById('u').focus();
  }
  render();
}

// --- Konto ----------------------------------------------------------------

export async function accountPage() {
  if (needLogin()) return;
  if (!META) await loadMeta().catch(() => {});
  const addParam = new URLSearchParams(location.search).get('add');
  const connectUrl = () => `${location.origin}/konto?add=${encodeURIComponent(ME.account.username)}`;

  $app.innerHTML = `
    <div class="page">
      ${topline()}
      <h1 id="hello"></h1>
      <p class="lead">Dein Benutzername ist <b>@${esc(ME.account.username)}</b> — damit kann man dich anfragen.</p>
      <button class="btn small" id="shareConnect">🔗 Link zum Verbinden teilen</button>
      <div id="dyn"></div>
      <div class="section">
        ${h3('Jemanden verbinden')}
        <form class="row" id="addForm">
          <input class="input" id="addName" placeholder="Benutzername, z. B. anna" autocapitalize="none" spellcheck="false" style="flex:1;min-width:160px" />
          <button class="btn primary">Anfragen</button>
        </form>
        <p class="hint">Sobald die Anfrage angenommen ist, habt ihr eine gemeinsame Watchlist und könnt euch direkt zu Sessions einladen.</p>
      </div>
      <details class="section">
        <summary>⚙️ Konto-Einstellungen</summary>
        <form class="card-panel form" id="nameForm">
          <div class="field"><label for="dn">Anzeigename</label><input class="input" id="dn" maxlength="24" /></div>
          <button class="btn small">Speichern</button>
        </form>
        <form class="card-panel form" id="pwForm" style="margin-top:12px">
          <div class="field"><label for="pw0">Aktuelles Passwort</label><input class="input" id="pw0" type="password" autocomplete="current-password" /></div>
          <div class="field"><label for="pw1">Neues Passwort</label><input class="input" id="pw1" type="password" autocomplete="new-password" minlength="8" /></div>
          <button class="btn small">Passwort ändern</button>
          <p class="hint">Meldet alle anderen Geräte ab.</p>
        </form>
        <div class="card-panel form danger" style="margin-top:12px">
          <b>Konto löschen</b>
          <p class="hint" style="margin:0">Löscht Konto, Verbindungen und alle Watchlists — auch die gemeinsamen. Sessions bleiben als Gast erhalten.</p>
          <button class="btn small" id="delete">Konto löschen …</button>
        </div>
      </details>
      <button class="btn block" id="logout" style="margin-top:8px">Abmelden</button>
    </div>`;

  const q = (id) => document.getElementById(id);
  q('dn').value = ME.account.name;
  if (addParam && addParam.toLowerCase() !== ME.account.username.toLowerCase()) q('addName').value = addParam;

  function render() {
    q('hello').textContent = `Hallo, ${ME.account.name} 👋`;
    const invites = ME.invites.map((inv) => `
      <div class="item-row">
        <div class="grow">🍿 <b>${esc(inv.from.name)}</b> lädt dich zu einer Session ein
          <div class="sub">${inv.room.count} Titel · ${esc(inv.room.players.join(', '))} · ${timeAgo(inv.at)}</div></div>
        <a class="btn small primary" href="/r/${esc(inv.roomId)}" data-link>Mitmachen</a>
      </div>`).join('');
    const incoming = ME.incoming.map((f) => `
      <div class="item-row">
        <div class="grow">👤 <b>${esc(f.name)}</b> <span class="sub">@${esc(f.username)}</span> möchte sich verbinden</div>
        <button class="btn small primary" data-friend="${f.id}" data-do="accept">Annehmen</button>
        <button class="btn small" data-friend="${f.id}" data-do="decline">Ablehnen</button>
      </div>`).join('');
    const lists = ME.lists.map((l) => `
      <a class="list-card" href="/w/${l.id}" data-link>
        <span class="icon">${l.partner ? '💞' : '📌'}</span>
        <span class="grow"><b>${esc(l.title)}</b>
          <span class="sub">${l.open} offen · ${l.watched} gesehen</span></span>
        ${l.unrated ? `<span class="dot" title="Von dir noch nicht bewertet">${l.unrated}</span>` : ''}
        <span class="chev">›</span>
      </a>`).join('');
    const friends = [
      ...ME.friends.map((f) => `
        <div class="item-row">
          <div class="grow">👤 <b>${esc(f.name)}</b> <span class="sub">@${esc(f.username)}</span></div>
          <button class="btn small ghost" data-friend="${f.id}" data-do="remove" data-name="${esc(f.name)}">Entfernen</button>
        </div>`),
      ...ME.outgoing.map((f) => `
        <div class="item-row muted">
          <div class="grow">⏳ <b>${esc(f.name)}</b> <span class="sub">@${esc(f.username)} · Anfrage gesendet ${timeAgo(f.at)}</span></div>
          <button class="btn small ghost" data-friend="${f.id}" data-do="cancel">Zurückziehen</button>
        </div>`),
    ].join('');
    const rooms = ME.rooms.map((r) => `
      <a class="item-row link" href="/r/${esc(r.id)}" data-link>
        <div class="grow"><b>${esc(r.players.join(' & '))}</b>
          <div class="sub">${r.filters?.source === 'watchlist' ? '📌 aus der Watchlist · ' : ''}${r.mine ?? 0}/${r.count} geswipt · ${r.matches} Match${r.matches === 1 ? '' : 'es'}${r.winner ? ` · 🏆 ${esc(r.winner)}` : ''} · ${timeAgo(r.updatedAt)}</div></div>
        <span class="chev">›</span>
      </a>`).join('');

    q('dyn').innerHTML = `
      ${invites ? `<div class="section">${h3('Einladungen')}${invites}</div>` : ''}
      ${incoming ? `<div class="section">${h3('Anfragen')}${incoming}</div>` : ''}
      <div class="section">${h3('Watchlists')}${lists}</div>
      <div class="section">${h3(`Verbunden (${ME.friends.length})`)}${friends || '<p class="hint">Noch niemand — frag unten jemanden an oder teile deinen Link.</p>'}</div>
      ${rooms ? `<div class="section">${h3('Deine Sessions')}${rooms}</div>` : ''}`;
  }
  render();
  onMe(render);

  q('dyn').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-friend]');
    if (!b) return;
    const what = b.dataset.do;
    if (what === 'remove' && !confirm(`Verbindung mit ${b.dataset.name} entfernen? Eure gemeinsame Watchlist bleibt gespeichert und ist wieder da, wenn ihr euch neu verbindet.`)) return;
    b.disabled = true;
    try {
      const r = await api(`/friends/${b.dataset.friend}`, { action: what === 'cancel' ? 'remove' : what });
      if (what === 'accept') toast(`Verbunden mit ${r.friend.name} 💞 — eure gemeinsame Watchlist ist bereit`);
    } catch (err) {
      toast(err.message);
      b.disabled = false;
    }
  });

  q('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = q('addName').value.trim();
    if (!name) return q('addName').focus();
    try {
      const r = await api('/friends', { username: name });
      toast(r.status === 'accepted' ? `Verbunden mit ${r.friend.name} 💞` : `Anfrage an ${r.friend.name} gesendet`);
      q('addName').value = '';
      history.replaceState(null, '', '/konto');
    } catch (err) {
      toast(err.message);
    }
  });

  q('shareConnect').onclick = () => share(connectUrl(), `Verbinde dich mit mir auf couchmatch (@${ME.account.username})`);

  q('nameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/me/profile', { name: q('dn').value });
      await loadMe();
      render();
      toast('Gespeichert ✓');
    } catch (err) {
      toast(err.message);
    }
  });
  q('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/me/password', { current: q('pw0').value, next: q('pw1').value });
      q('pw0').value = q('pw1').value = '';
      toast('Passwort geändert ✓');
    } catch (err) {
      toast(err.message);
    }
  });
  q('delete').onclick = () => {
    const ov = sheet(`
      <h2 style="margin:4px 0 8px">Konto wirklich löschen?</h2>
      <p style="color:var(--muted)">Das lässt sich nicht rückgängig machen. Gib zur Bestätigung dein Passwort ein.</p>
      <input class="input" id="delPw" type="password" autocomplete="current-password" />
      <div class="row" style="margin-top:12px">
        <button class="btn" data-close style="flex:1">Abbrechen</button>
        <button class="btn danger" id="delGo" style="flex:1">Endgültig löschen</button>
      </div>`);
    ov.querySelector('#delGo').onclick = async () => {
      try {
        await api('/me/delete', { password: ov.querySelector('#delPw').value });
        ov.remove();
        await loadMe();
        toast('Konto gelöscht');
        go('/');
      } catch (err) {
        toast(err.message);
      }
    };
  };
  q('logout').onclick = async () => {
    await api('/auth/logout', {}).catch(() => {});
    await loadMe();
    go('/');
  };
}

// --- Watchlist ------------------------------------------------------------

export async function watchlistPage(listId) {
  if (needLogin()) return;
  loading('Lade Watchlist …');
  if (!META) await loadMeta().catch(() => {});
  let data;
  try {
    data = await api(`/lists/${listId}`);
  } catch (err) {
    $app.innerHTML = `<div class="center-screen"><div><div style="font-size:48px">🤷</div><p>${esc(err.message)}</p><a class="btn primary" href="/konto" data-link>Zum Konto</a></div></div>`;
    return;
  }
  let tab = 'open';
  let onlyUnrated = false;
  const me = ME.account.id;
  const partner = () => data.members.find((m) => m.id !== me);
  const entryOf = (id) => data.entries.find((e) => e.id === Number(id));

  $app.innerHTML = `
    <div class="page">
      ${topline(`<a class="pill" href="/konto" data-link>← Konto</a>`)}
      <h1 id="title"></h1>
      <p class="lead" id="lead"></p>
      <div class="search">
        <input class="input" id="search" type="search" placeholder="🔎 Film oder Serie hinzufügen …" autocomplete="off" />
        <div class="search-results" id="results"></div>
      </div>
      <div class="row" id="actions" style="margin-top:14px"></div>
      <div class="tabs" id="tabs"></div>
      <div id="entries"></div>
    </div>`;
  const q = (id) => document.getElementById(id);

  let alive = true;
  onLeave(() => (alive = false));
  const reload = async () => {
    try {
      const next = await api(`/lists/${listId}`);
      if (!alive) return; // Seite inzwischen verlassen
      data = next;
      render();
    } catch (err) {
      // Verbindung entfernt o. ä. → zurück zum Konto
      toast(err.message);
      go('/konto');
    }
  };
  onMe(reload);

  function prioChips(e) {
    const mine = e.ratings[me]?.priority;
    return [0, 1, 2, 3]
      .map((p) => `<button class="prio${mine === p ? ' on' : ''}" data-prio="${p}" data-entry="${e.id}" title="${esc(prioLabel(p))}">${esc(prioLabel(p).split(' ')[0])}</button>`)
      .join('');
  }

  function stars(e, accountId, editable) {
    const n = e.ratings[accountId]?.stars || 0;
    if (!editable) return n ? `<span class="stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>` : '<span class="sub">noch keine Sterne</span>';
    return `<span class="stars edit">${[1, 2, 3, 4, 5]
      .map((s) => `<button data-stars="${s}" data-entry="${e.id}" class="${s <= n ? '' : 'off'}" aria-label="${s} Sterne">★</button>`)
      .join('')}</span>`;
  }

  function entryHtml(e) {
    const it = e.item;
    const p = partner();
    const watched = !!e.watchedAt;
    const partnerPrio = p && e.ratings[p.id]?.priority;
    const rows = watched
      ? `<div class="rate-row"><span class="who">Du</span>${stars(e, me, true)}</div>
         ${p ? `<div class="rate-row"><span class="who">${esc(p.name)}</span>${stars(e, p.id, false)}</div>` : ''}`
      : `<div class="rate-row"><span class="who">Du</span><span class="prios">${prioChips(e)}</span></div>
         ${p ? `<div class="rate-row"><span class="who">${esc(p.name)}</span><span class="${partnerPrio == null ? 'sub' : ''}">${esc(prioLabel(partnerPrio))}</span></div>` : ''}`;
    return `
      <div class="result entry${e.ratings[me]?.priority == null && !watched ? ' unrated' : ''}">
        <img src="${esc(it.poster)}" alt="" loading="lazy" />
        <div class="meta">
          <h4>${esc(it.name)}${e.together && !watched ? '<span class="tag strong">💞 BEIDE</span>' : ''}</h4>
          <div class="sub">${[it.rating ? `IMDb ${it.rating.toFixed(1)}` : null, ...itemMeta(it)].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="sub">${(it.genres || []).map(genreDe).map(esc).join(', ')}${watched ? ` · gesehen ${timeAgo(e.watchedAt)}` : ''}</div>
          ${rows}
          <div class="links">${linksHtml(it)}
            ${watched
              ? `<button class="btn" data-act="unwatched" data-entry="${e.id}">↶ Doch nicht gesehen</button>`
              : `<button class="btn seen" data-act="watched" data-entry="${e.id}">✓ Gesehen</button>`}
            <button class="btn ghost" data-act="remove" data-entry="${e.id}" title="Entfernen">🗑</button>
          </div>
        </div>
      </div>`;
  }

  function render() {
    const open = data.entries.filter((e) => !e.watchedAt);
    const seen = data.entries.filter((e) => e.watchedAt);
    const unrated = open.filter((e) => e.ratings[me]?.priority == null);
    const p = partner();
    q('title').textContent = (p ? '💞 ' : '📌 ') + data.title;
    q('lead').textContent = p
      ? `Eure gemeinsame Liste. Bewertet beide, wie wichtig euch ein Titel ist — oben steht, worauf ihr beide am meisten Lust habt.`
      : 'Deine eigene Liste — für alles, was du dir merken willst.';

    q('actions').innerHTML = open.length
      ? `<button class="btn primary" data-act="session" style="flex:1" ${open.length < 2 ? 'disabled' : ''}>🎬 ${p ? 'Gemeinsam swipen' : 'Daraus eine Session machen'} (${open.length})</button>
         <button class="btn" data-act="pick" style="flex:1">🎲 Was schauen wir heute?</button>`
      : '';

    q('tabs').innerHTML = `
      <button class="chip${tab === 'open' ? ' on' : ''}" data-tab="open">Offen (${open.length})</button>
      <button class="chip${tab === 'seen' ? ' on' : ''}" data-tab="seen">Gesehen (${seen.length})</button>
      ${tab === 'open' && unrated.length ? `<button class="chip${onlyUnrated ? ' on' : ''}" data-tab="unrated">Noch nicht bewertet (${unrated.length})</button>` : ''}`;

    let list = tab === 'open' ? (onlyUnrated ? unrated : open) : seen;
    if (onlyUnrated && !unrated.length) {
      onlyUnrated = false;
      list = open;
    }
    q('entries').innerHTML = list.length
      ? list.map(entryHtml).join('')
      : `<div class="empty-inline"><div style="font-size:40px">${tab === 'open' ? '🍿' : '📼'}</div>
           <p>${tab === 'open'
             ? 'Noch nichts drauf. Such oben nach Titeln oder merk dir Matches direkt aus einer Session (📌).'
             : 'Noch nichts als gesehen markiert.'}</p></div>`;
  }
  render();

  // --- Suche ---
  const search = debounce(async () => {
    const term = q('search').value.trim();
    if (term.length < 2) return (q('results').innerHTML = '');
    try {
      const { results } = await api(`/search?q=${encodeURIComponent(term)}`);
      if (q('search').value.trim() !== term) return;
      const have = new Set(data.entries.map((e) => e.item.id));
      q('results').innerHTML = results.length
        ? results.map((it) => `
            <div class="hit">
              <img src="${esc(it.poster)}" alt="" loading="lazy" />
              <div class="grow"><b>${esc(it.name)}</b><div class="sub">${itemMeta(it).map(esc).join(' · ')}${it.rating ? ` · IMDb ${it.rating.toFixed(1)}` : ''}</div></div>
              ${have.has(it.id) ? '<span class="sub">✓ drauf</span>' : `<button class="btn small primary" data-add="${esc(it.id)}">+</button>`}
            </div>`).join('')
        : '<p class="hint" style="padding:8px 12px">Nichts gefunden.</p>';
    } catch (err) {
      toast(err.message);
    }
  }, 250);
  q('search').addEventListener('input', search);
  q('results').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    b.disabled = true;
    try {
      await api(`/lists/${listId}/items`, { itemId: b.dataset.add, priority: 2 });
      b.outerHTML = '<span class="sub">✓ drauf</span>';
      toast('📌 Hinzugefügt — Wichtigkeit: 😍 Will ich');
      await reload();
    } catch (err) {
      toast(err.message);
      b.disabled = false;
    }
  });

  // --- Aktionen ---
  async function entryAction(entryId, body) {
    try {
      await api(`/entries/${entryId}`, body);
      await reload();
    } catch (err) {
      toast(err.message);
    }
  }

  $app.querySelector('.page').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-trailer]');
    if (t) return openTrailer(data.entries.find((x) => x.item.id === t.dataset.trailer).item);
    const el = e.target.closest('[data-tab], [data-prio], [data-stars], [data-act]');
    if (!el) return;
    const d = el.dataset;
    if (d.tab) {
      if (d.tab === 'unrated') onlyUnrated = !onlyUnrated;
      else {
        tab = d.tab;
        onlyUnrated = false;
      }
      return render();
    }
    if (d.prio) {
      const entry = entryOf(d.entry);
      const cur = entry.ratings[me]?.priority;
      const next = cur === Number(d.prio) ? null : Number(d.prio); // nochmal tippen = zurücksetzen
      entry.ratings[me] = { ...entry.ratings[me], priority: next };
      render();
      return entryAction(d.entry, { action: 'rate', priority: next });
    }
    if (d.stars) {
      const entry = entryOf(d.entry);
      const next = entry.ratings[me]?.stars === Number(d.stars) ? null : Number(d.stars);
      entry.ratings[me] = { ...entry.ratings[me], stars: next };
      render();
      return entryAction(d.entry, { action: 'rate', stars: next });
    }
    if (d.act === 'watched') {
      toast('✓ Als gesehen markiert — wie war\'s? Sterne gibt\'s unter „Gesehen"');
      return entryAction(d.entry, { action: 'watched' });
    }
    if (d.act === 'unwatched') return entryAction(d.entry, { action: 'unwatched' });
    if (d.act === 'remove') {
      if (!confirm(`„${entryOf(d.entry).item.name}" von der Liste nehmen?`)) return;
      return entryAction(d.entry, { action: 'remove' });
    }
    if (d.act === 'session') return startSession(el);
    if (d.act === 'pick') return pickTonight();
  });

  async function startSession(btn) {
    btn.disabled = true;
    try {
      const p = partner();
      const r = await api('/rooms', { listId, superLimit: 3, vetoLimit: 1, invite: p ? [p.id] : [] });
      creds.set(r.roomId, { playerId: r.playerId, token: r.token });
      sessionStorage.setItem('couchmatch:justCreated', r.roomId);
      if (p) toast(`${p.name} ist eingeladen ✉️`);
      go('/r/' + r.roomId);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  }

  // Gewichteter Zufall: je wichtiger für beide, desto wahrscheinlicher.
  // Titel, bei denen jemand "eher nicht" gesagt hat, nur wenn sonst nichts übrig ist.
  function pickTonight(exclude = new Set()) {
    const open = data.entries.filter((e) => !e.watchedAt && !exclude.has(e.id));
    if (!open.length) return toast('Keine weiteren offenen Titel');
    const ok = open.filter((e) => !Object.values(e.ratings).some((r) => r.priority === 0));
    const pool = ok.length ? ok : open;
    const weight = (e) => (e.score + 1) ** 2;
    let r = Math.random() * pool.reduce((s, e) => s + weight(e), 0);
    const e = pool.find((x) => (r -= weight(x)) < 0) || pool[0];
    const it = e.item;
    const ov = sheet(`
      <div class="final-winner">
        <div class="trophy">🎲</div>
        <p class="hint" style="margin:0">Wie wär's mit</p>
        <img src="${esc(it.poster)}" alt="" />
        <h2>${esc(it.name)}</h2>
        <div class="sub">${[it.rating ? `IMDb ${it.rating.toFixed(1)}` : null, ...itemMeta(it)].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="links" style="justify-content:center">${linksHtml(it)}</div>
      </div>
      <div class="row" style="margin-top:18px">
        <button class="btn" id="again" style="flex:1">🎲 Nochmal</button>
        <button class="btn primary" id="take" style="flex:1">✓ Den schauen wir</button>
      </div>
      <p class="hint" style="text-align:center">„Den schauen wir" markiert ihn als gesehen.</p>`);
    ov.querySelector('[data-trailer]').onclick = () => openTrailer(it);
    ov.querySelector('#again').onclick = () => {
      exclude.add(e.id);
      pickTonight(exclude);
    };
    ov.querySelector('#take').onclick = async () => {
      ov.remove();
      toast(`Viel Spaß mit ${it.name} 🍿`);
      await entryAction(e.id, { action: 'watched' });
    };
  }
}
