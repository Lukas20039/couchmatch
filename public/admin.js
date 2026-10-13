// couchmatch — Admin-Statistik (nur Kennzahlen, keine Inhalte einzelner Listen).

import { $app, ME, api, esc, loading, needLogin, timeAgo, topline } from './common.js';

const fmt = (n) => Number(n || 0).toLocaleString('de');

function tile(value, label, sub = '') {
  return `<div class="tile"><div class="tile-value">${fmt(value)}</div><div class="tile-label">${esc(label)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

// Säulen pro Tag — eine Reihe, eine Farbe, Wert im Tooltip
function dayBars(series, title, unit) {
  const max = Math.max(1, ...series.map((d) => d.n));
  const total = series.reduce((s, d) => s + d.n, 0);
  const label = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('de', { day: 'numeric', month: 'short' });
  return `
    <figure class="chart">
      <figcaption><b>${esc(title)}</b><span class="sub">${fmt(total)} in 30 Tagen · max. ${fmt(max)}/Tag</span></figcaption>
      <div class="bars" role="img" aria-label="${esc(title)}: ${series.map((d) => `${label(d.day)} ${d.n}`).join(', ')}">
        ${series.map((d) => `
          <div class="bar-slot" tabindex="0" data-tip="${esc(label(d.day))}: ${fmt(d.n)} ${esc(unit)}">
            <div class="bar" style="height:${d.n ? Math.max(4, (d.n / max) * 100) : 0}%"></div>
          </div>`).join('')}
      </div>
      <div class="bars-axis"><span>${esc(label(series[0].day))}</span><span>heute</span></div>
    </figure>`;
}

export async function adminPage() {
  if (needLogin()) return;
  loading('Lade Statistik …');
  let s;
  try {
    s = await api('/admin/stats');
  } catch (err) {
    $app.innerHTML = `<div class="center-screen"><div><div style="font-size:48px">🔒</div><p>${esc(err.message)}</p><a class="btn primary" href="/konto" data-link>Zum Konto</a></div></div>`;
    return;
  }
  const a = s.accounts;
  const w = s.watchlists;
  $app.innerHTML = `
    <div class="page wide">
      ${topline(`<a class="pill" href="/konto" data-link>← Konto</a>`)}
      <h1>📊 Statistik</h1>
      <p class="lead">Stand ${new Date().toLocaleString('de')} · angemeldet als ${esc(ME.account.name)}</p>

      <h3 class="sec-title">Konten</h3>
      <div class="tiles">
        ${tile(a.total, 'Konten', `+${fmt(a.new7)} in 7 Tagen · +${fmt(a.new30)} in 30`)}
        ${tile(a.active7, 'aktiv (7 Tage)', `${fmt(a.active30)} in 30 Tagen`)}
        ${tile(s.pairs.total, 'Paare', `${fmt(s.pairs.pending)} Anfragen offen`)}
        ${tile(a.solo, 'ohne Verbindung')}
        ${tile(a.withPush, 'mit Push')}
      </div>

      <h3 class="sec-title">Watchlists</h3>
      <div class="tiles">
        ${tile(s.pairs.withList, 'Paar-Listen in Gebrauch', `${fmt(s.pairs.active7)} aktiv in 7 Tagen`)}
        ${tile(w.entries, 'Einträge', `${fmt(w.open)} offen · ${fmt(w.watched)} gesehen`)}
        ${tile(w.ratings, 'Bewertungen')}
        ${tile(w.comments, 'Kommentare', `${fmt(w.reactions)} Reaktionen`)}
        ${tile(w.vetoed, 'Vetos', `${fmt(w.manual)} selbst eingetragen`)}
      </div>

      <h3 class="sec-title">Sessions (aktiv, letzte 30 Tage)</h3>
      <div class="tiles">
        ${tile(s.sessions.active, 'Sessions', `${fmt(s.sessions.last7)} neu in 7 Tagen`)}
        ${tile(s.sessions.together, 'zu zweit oder mehr')}
        ${tile(s.sessions.withAccounts, 'mit Konto', `${fmt(s.sessions.fromWatchlist)} aus Watchlists`)}
        ${tile(s.sessions.matches, 'Matches', `${fmt(s.sessions.finals)} Finale entschieden`)}
        ${tile(s.sessions.players, 'Mitspielende', `davon ${fmt(s.sessions.guests)} Gäste`)}
      </div>

      ${dayBars(s.signups, 'Neue Konten pro Tag', 'neue Konten')}
      ${dayBars(s.activity, 'Watchlist-Aktivität pro Tag', 'Aktivitäten')}

      <h3 class="sec-title">Meistgemerkte Titel</h3>
      ${s.topTitles.length ? `<table class="table">
        <thead><tr><th></th><th>Titel</th><th class="num">Listen</th><th class="num">gesehen</th></tr></thead>
        <tbody>${s.topTitles.map((t) => `
          <tr><td><img src="${esc(t.poster || '')}" alt="" loading="lazy" /></td><td>${esc(t.name)}</td>
          <td class="num">${fmt(t.lists)}</td><td class="num">${fmt(t.watched)}</td></tr>`).join('')}</tbody>
      </table>` : '<p class="sub">Noch nichts gemerkt.</p>'}

      <h3 class="sec-title">Konten (${fmt(s.users.length)})</h3>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Konto</th><th>angelegt</th><th>zuletzt aktiv</th><th class="num">Verb.</th><th class="num">gemerkt</th><th>Push</th></tr></thead>
        <tbody>${s.users.map((u) => `
          <tr><td><b>${esc(u.name)}</b><div class="sub">@${esc(u.username)}</div></td>
          <td>${timeAgo(u.createdAt)}</td><td>${u.lastSeen ? timeAgo(u.lastSeen) : '—'}</td>
          <td class="num">${fmt(u.friends)}</td><td class="num">${fmt(u.added)}</td><td>${u.push ? '🔔' : ''}</td></tr>`).join('')}</tbody>
      </table></div>

      <p class="hint">Film-Datenbank: ${fmt(s.catalog.count)} Titel, aktualisiert ${s.catalog.updatedAt ? timeAgo(s.catalog.updatedAt) : '—'}.
      Admins legst du mit <code>ADMIN_USERS=name1,name2</code> fest (sonst ist das erste Konto Admin).</p>
    </div>`;
}
