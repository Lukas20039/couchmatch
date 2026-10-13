// couchmatch — Konto-Seiten: Anmeldung, Konto (Freunde, Einladungen) und Watchlists.

import {
  $app, ME, META, api, esc, go, loadMe, loadMeta, needLogin, nextPath, onMe, pushSupport, share, sheet, subscribePush,
  timeAgo, toast, topline, unsubscribePush,
} from './common.js';

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
      <div class="row">
        <button class="btn small" id="shareConnect">🔗 Link zum Verbinden teilen</button>
        ${ME.account.admin ? '<a class="btn small" href="/admin" data-link>📊 Statistik</a>' : ''}
      </div>
      <div id="dyn"></div>
      <div class="section">
        ${h3('Benachrichtigungen')}
        <div id="push"></div>
      </div>
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
        ${l.unread ? `<span class="badge-new" title="Neue Aktivität">💬 ${l.unread} neu</span>` : ''}
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

  renderPush(q('push'));

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

// --- Push-Benachrichtigungen auf diesem Gerät ------------------------------

async function renderPush(el) {
  const st = await pushSupport();
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  if (!st.supported) {
    el.innerHTML = `<p class="hint" style="margin:0">${ios && !navigator.standalone
      ? 'Auf dem iPhone/iPad gehen Push-Nachrichten nur, wenn couchmatch zum Home-Bildschirm hinzugefügt ist: Teilen-Symbol → „Zum Home-Bildschirm", dann von dort öffnen.'
      : 'Dieser Browser unterstützt keine Push-Benachrichtigungen (oder die Seite läuft ohne HTTPS).'}</p>`;
    return;
  }
  if (st.permission === 'denied') {
    el.innerHTML = '<p class="hint" style="margin:0">Benachrichtigungen sind für diese Seite im Browser blockiert. Erlaube sie in den Website-Einstellungen und lade neu.</p>';
    return;
  }
  el.innerHTML = st.sub
    ? `<div class="item-row"><div class="grow">🔔 Auf diesem Gerät aktiv
         <div class="sub">Du bekommst Bescheid bei neuen Titeln, Kommentaren, Vetos, Reaktionen, Anfragen und Einladungen.</div></div>
         <button class="btn small" id="pushTest">Test</button>
         <button class="btn small ghost" id="pushOff">Ausschalten</button></div>`
    : `<button class="btn" id="pushOn">🔔 Push auf diesem Gerät aktivieren</button>
       <p class="hint">Z. B. wenn dein Gegenüber etwas auf eure Watchlist setzt oder kommentiert.</p>`;
  el.querySelector('#pushOn')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await subscribePush();
      toast('🔔 Benachrichtigungen aktiviert');
    } catch (err) {
      toast(err.message);
    }
    renderPush(el);
  });
  el.querySelector('#pushOff')?.addEventListener('click', async () => {
    await unsubscribePush().catch((err) => toast(err.message));
    renderPush(el);
  });
  el.querySelector('#pushTest')?.addEventListener('click', async () => {
    try {
      const r = await api('/me/push/test', {});
      toast(r.delivered ? `Test an ${r.delivered} von ${r.devices} Gerät(en) geschickt` : 'Kein Gerät hat den Test angenommen');
    } catch (err) {
      toast(err.message);
    }
  });
}
