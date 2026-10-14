// couchmatch — Watchlist-Seite: Einträge bewerten, Veto, Kommentare, Verlauf mit Reaktionen.

import {
  $app, ME, META, api, creds, debounce, esc, genreDe, go, itemMeta, linksHtml, loadMeta, loading, needLogin, onLeave,
  onMe, openTrailer, prioLabel, sheet, timeAgo, toast, topline,
} from './common.js';

const KIND_ICON = { add: '📌', comment: '💬', veto: '🚫', watched: '✓', stars: '⭐' };

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
  const params = new URLSearchParams(location.search);
  let tab = params.get('tab') === 'activity' ? 'activity' : 'open';
  let onlyUnrated = false;
  let feed = null; // Verlauf der ganzen Liste, nur geladen solange der Tab offen ist
  let detail = null; // { entryId, ov, thread }
  let pickerFor = null; // Aktivität, deren Smiley-Auswahl gerade offen ist
  const me = ME.account.id;
  const partner = () => data.members.find((m) => m.id !== me);
  const entryOf = (id) => data.entries.find((e) => e.id === Number(id));
  // Für "… von X": eigenes Konto als "dir"
  const byName = (id) => (id === me ? 'dir' : data.members.find((m) => m.id === id)?.name || '?');

  $app.innerHTML = `
    <div class="page">
      ${topline(`<a class="pill" href="/konto" data-link>← Konto</a>`)}
      <h1 id="title"></h1>
      <p class="lead" id="lead"></p>
      <div class="search">
        <input class="input" id="search" type="search" placeholder="🔎 Film oder Serie hinzufügen …" autocomplete="off" />
        <div class="search-results" id="results"></div>
        <button class="linkish" id="manualBtn">✍️ Nicht dabei? Selbst eintragen</button>
        <a class="linkish" href="/teilen" data-link>📲 Link aus TikTok & Co.</a>
      </div>
      <div class="row" id="actions" style="margin-top:14px"></div>
      <div class="tabs" id="tabs"></div>
      <div id="entries"></div>
    </div>`;
  const q = (id) => document.getElementById(id);

  let alive = true;
  onLeave(() => {
    alive = false;
    detail?.ov.remove();
  });

  async function reload() {
    try {
      const [next, nextFeed, thread] = await Promise.all([
        api(`/lists/${listId}`),
        tab === 'activity' ? api(`/lists/${listId}/activity`) : null,
        detail ? api(`/lists/${listId}/activity?entry=${detail.entryId}`) : null,
      ]);
      if (!alive) return; // Seite inzwischen verlassen
      data = next;
      if (nextFeed) feed = nextFeed.activities;
      if (thread && detail) detail.thread = thread.activities;
      render();
      if (detail) renderDetail();
    } catch (err) {
      // Verbindung entfernt o. ä. → zurück zum Konto
      toast(err.message);
      go('/konto');
    }
  }
  onMe(reload);

  // --- Bausteine -------------------------------------------------------------

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

  function ratingRows(e) {
    const p = partner();
    if (e.watchedAt) {
      return `<div class="rate-row"><span class="who">Du</span>${stars(e, me, true)}</div>
        ${p ? `<div class="rate-row"><span class="who">${esc(p.name)}</span>${stars(e, p.id, false)}</div>` : ''}`;
    }
    const pp = p && e.ratings[p.id]?.priority;
    return `<div class="rate-row"><span class="who">Du</span><span class="prios">${prioChips(e)}</span></div>
      ${p ? `<div class="rate-row"><span class="who">${esc(p.name)}</span><span class="${pp == null ? 'sub' : ''}">${esc(prioLabel(pp))}</span></div>` : ''}`;
  }

  const vetoBadge = (e) => (e.vetoedBy ? `<div class="veto-note">🚫 Veto von ${esc(byName(e.vetoedBy))}</div>` : '');

  function entryHtml(e) {
    const it = e.item;
    const watched = !!e.watchedAt;
    const cls = ['result', 'entry'];
    if (e.ratings[me]?.priority == null && !watched && !e.vetoedBy) cls.push('unrated');
    if (e.vetoedBy) cls.push('vetoed');
    return `
      <div class="${cls.join(' ')}">
        <img src="${esc(it.poster)}" alt="" loading="lazy" data-open="${e.id}" />
        <div class="meta">
          <h4 data-open="${e.id}">${esc(it.name)}${e.together && !watched ? '<span class="tag strong">💞 BEIDE</span>' : ''}${it.manual ? '<span class="tag manual">✍️</span>' : ''}</h4>
          <div class="sub">${[it.rating ? `IMDb ${it.rating.toFixed(1)}` : null, ...itemMeta(it)].filter(Boolean).map(esc).join(' · ')}${watched ? ` · gesehen ${timeAgo(e.watchedAt)}` : ''}</div>
          ${vetoBadge(e)}
          ${ratingRows(e)}
          <div class="links">
            <button class="btn trailer" data-trailer="${esc(it.id)}">▶ Trailer</button>
            ${watched
              ? `<button class="btn" data-act="unwatched" data-entry="${e.id}">↶ Nicht gesehen</button>`
              : `<button class="btn seen" data-act="watched" data-entry="${e.id}">✓ Gesehen</button>`}
            <button class="btn" data-open="${e.id}">💬${e.comments ? ` ${e.comments}` : ''} · Mehr</button>
          </div>
        </div>
      </div>`;
  }

  function reactionBar(a) {
    const chips = a.reactions
      .map((r) => `<button class="react${r.mine ? ' on' : ''}" data-react="${esc(r.emoji)}" data-activity="${a.id}" title="${esc(r.names.join(', '))}">${r.emoji}${r.count > 1 ? ` ${r.count}` : ''}</button>`)
      .join('');
    const picker = pickerFor === a.id
      ? `<div class="react-picker">${(META.reactions || [])
          .map((emo) => `<button data-react="${emo}" data-activity="${a.id}">${emo}</button>`)
          .join('')}</div>`
      : '';
    return `<div class="reactions">${chips}<button class="react add" data-picker="${a.id}" aria-label="Reagieren">☺︎+</button></div>${picker}`;
  }

  function activityText(a, withItem = true) {
    const who = `<b>${esc(a.actor.id === me ? 'Du' : a.actor.name)}</b>`;
    const t = withItem && a.item ? ` <b>${esc(a.item.name)}</b>` : '';
    const verb = (du, sie) => (a.actor.id === me ? du : sie);
    switch (a.kind) {
      case 'add': return `${who} ${verb('hast', 'hat')}${t || ' den Titel'} hinzugefügt${a.data.priority != null ? ` · ${esc(prioLabel(a.data.priority))}` : ''}`;
      case 'comment': return `${who}${t ? ` zu${t}` : ''}:`;
      case 'veto': return `${who} ${verb('hast', 'hat')} ein Veto${t ? ` gegen${t}` : ''} eingelegt`;
      case 'watched': return `${who} ${verb('hast', 'hat')}${t || ' den Titel'} als gesehen markiert`;
      case 'stars': return `${who} ${verb('gibst', 'gibt')}${t} <span class="stars">${'★'.repeat(a.data.stars)}<span class="off">${'★'.repeat(5 - a.data.stars)}</span></span>`;
      default: return who;
    }
  }

  function activityHtml(a, { withItem = true } = {}) {
    const mineComment = a.kind === 'comment' && a.actor.id === me;
    return `
      <div class="activity${a.unread ? ' unread' : ''}" id="act-${a.id}">
        ${withItem && a.item ? `<img src="${esc(a.item.poster)}" alt="" loading="lazy" data-open="${a.entryId}" />` : `<span class="act-icon">${KIND_ICON[a.kind] || '•'}</span>`}
        <div class="grow">
          <div class="act-text">${activityText(a, withItem)}</div>
          ${a.kind === 'comment' ? `<div class="bubble">${esc(a.data.text)}</div>` : ''}
          <div class="sub">${timeAgo(a.at)}${mineComment ? ` · <button class="linkish" data-del="${a.id}">löschen</button>` : ''}</div>
          ${reactionBar(a)}
        </div>
      </div>`;
  }

  // --- Liste -----------------------------------------------------------------

  function render() {
    const open = data.entries.filter((e) => !e.watchedAt);
    const seen = data.entries.filter((e) => e.watchedAt);
    const unrated = open.filter((e) => e.ratings[me]?.priority == null && !e.vetoedBy);
    const candidates = open.filter((e) => !e.vetoedBy);
    const p = partner();
    q('title').textContent = (p ? '💞 ' : '📌 ') + data.title;
    q('lead').textContent = p
      ? 'Eure gemeinsame Liste. Bewertet beide, wie wichtig euch ein Titel ist — oben steht, worauf ihr beide am meisten Lust habt.'
      : 'Deine eigene Liste — für alles, was du dir merken willst.';

    q('actions').innerHTML = candidates.length
      ? `<button class="btn primary" data-act="session" style="flex:1" ${candidates.length < 2 ? 'disabled' : ''}>🎬 ${p ? 'Gemeinsam swipen' : 'Daraus eine Session machen'} (${candidates.length})</button>
         <button class="btn" data-act="pick" style="flex:1">🎲 Was schauen wir heute?</button>`
      : '';

    q('tabs').innerHTML = `
      <button class="chip${tab === 'open' ? ' on' : ''}" data-tab="open">Offen (${open.length})</button>
      <button class="chip${tab === 'seen' ? ' on' : ''}" data-tab="seen">Gesehen (${seen.length})</button>
      ${p ? `<button class="chip${tab === 'activity' ? ' on' : ''}" data-tab="activity">💬 Aktivität${data.unread ? `<span class="dot">${data.unread}</span>` : ''}</button>` : ''}
      ${tab === 'open' && unrated.length ? `<button class="chip${onlyUnrated ? ' on' : ''}" data-tab="unrated">Noch nicht bewertet (${unrated.length})</button>` : ''}`;

    if (tab === 'activity') {
      q('entries').innerHTML = !feed
        ? '<div class="empty-inline"><div class="spinner"></div></div>'
        : feed.length
          ? feed.map((a) => activityHtml(a)).join('')
          : '<div class="empty-inline"><div style="font-size:40px">💬</div><p>Noch nichts passiert. Hier landet alles, was ihr hinzufügt, kommentiert oder per Veto streicht — und ihr könnt darauf reagieren.</p></div>';
      return;
    }

    let list = tab === 'open' ? (onlyUnrated ? unrated : open) : seen;
    if (onlyUnrated && !unrated.length) {
      onlyUnrated = false;
      list = open;
    }
    q('entries').innerHTML = list.length
      ? list.map(entryHtml).join('')
      : `<div class="empty-inline"><div style="font-size:40px">${tab === 'open' ? '🍿' : '📼'}</div>
           <p>${tab === 'open'
             ? 'Noch nichts drauf. Such oben nach Titeln, trag selbst einen ein oder merk dir Matches direkt aus einer Session (📌).'
             : 'Noch nichts als gesehen markiert.'}</p></div>`;
  }

  async function openTab(next) {
    tab = next;
    onlyUnrated = false;
    pickerFor = null;
    history.replaceState(null, '', next === 'activity' ? `?tab=activity` : location.pathname);
    render();
    if (next === 'activity') {
      feed = (await api(`/lists/${listId}/activity`)).activities;
      if (!alive || tab !== 'activity') return;
      render();
      if (data.unread) api(`/lists/${listId}/seen`, {}).catch(() => {});
    }
  }

  // --- Detailansicht eines Eintrags -------------------------------------------

  async function openDetail(entryId) {
    pickerFor = null;
    detail = { entryId: Number(entryId), ov: sheet('<div class="detail-body"></div>'), thread: null };
    detail.ov.addEventListener('click', onClick);
    detail.ov.addEventListener('submit', onSubmit);
    const close = new MutationObserver(() => {
      if (!document.body.contains(detail?.ov)) {
        detail = null;
        pickerFor = null;
        close.disconnect();
      }
    });
    close.observe(document.body, { childList: true });
    renderDetail();
    const { activities } = await api(`/lists/${listId}/activity?entry=${entryId}`);
    if (detail?.entryId !== Number(entryId)) return;
    detail.thread = activities;
    renderDetail();
  }

  function renderDetail() {
    const e = entryOf(detail.entryId);
    const body = detail.ov.querySelector('.detail-body');
    if (!e) {
      body.innerHTML = '<p class="sub">Dieser Titel ist nicht mehr auf der Liste.</p>';
      return;
    }
    // Eingetippten Kommentar beim Neuzeichnen behalten
    const draft = body.querySelector('#commentText')?.value || '';
    const it = e.item;
    const p = partner();
    const thread = detail.thread ? [...detail.thread].reverse() : null;
    const vetoBtn = e.vetoedBy
      ? e.vetoedBy === me ? `<button class="btn" data-act="unveto" data-entry="${e.id}">↶ Veto zurücknehmen</button>` : ''
      : !e.watchedAt && p ? `<button class="btn veto" data-act="veto" data-entry="${e.id}">🚫 Veto</button>` : '';
    body.innerHTML = `
      <div class="detail-head">
        <img src="${esc(it.poster)}" alt="" />
        <div class="grow">
          <h2>${esc(it.name)}</h2>
          <div class="sub">${[it.rating ? `IMDb ${it.rating.toFixed(1)}` : null, ...itemMeta(it)].filter(Boolean).map(esc).join(' · ')}</div>
          <div class="sub">${(it.genres || []).map(genreDe).map(esc).join(', ')}</div>
          <div class="sub">${it.manual ? '✍️ selbst eingetragen' : '📌 hinzugefügt'} von ${esc(byName(e.addedBy))} · ${timeAgo(e.addedAt)}</div>
        </div>
      </div>
      ${it.description ? `<p class="detail-desc">${esc(it.description)}</p>` : ''}
      ${vetoBadge(e)}
      ${ratingRows(e)}
      <div class="links">${linksHtml(it)}</div>
      <div class="links">
        ${e.watchedAt
          ? `<button class="btn" data-act="unwatched" data-entry="${e.id}">↶ Nicht gesehen</button>`
          : `<button class="btn seen" data-act="watched" data-entry="${e.id}">✓ Gesehen</button>`}
        ${vetoBtn}
        <button class="btn ghost" data-act="remove" data-entry="${e.id}">🗑 Entfernen</button>
      </div>
      ${p ? `
        <h3 class="sec-title" style="margin-top:22px">Kommentare & Verlauf</h3>
        <div class="thread">${!thread ? '<div class="spinner"></div>' : thread.length ? thread.map((a) => activityHtml(a, { withItem: false })).join('') : '<p class="sub">Noch nichts — schreib als Erste:r was dazu.</p>'}</div>
        <form class="comment-form" id="commentForm">
          <input class="input" id="commentText" maxlength="500" placeholder="Kommentar zu ${esc(it.name)} …" autocomplete="off" />
          <button class="btn primary">Senden</button>
        </form>` : ''}`;
    if (draft) body.querySelector('#commentText').value = draft;
  }

  // --- Suche & selbst eintragen ------------------------------------------------

  const search = debounce(async () => {
    const term = q('search').value.trim();
    if (term.length < 2) return (q('results').innerHTML = '');
    try {
      const { results } = await api(`/search?q=${encodeURIComponent(term)}`);
      if (!alive || q('search').value.trim() !== term) return;
      const have = new Set(data.entries.map((e) => e.item.id));
      q('results').innerHTML = results.length
        ? results.map((it) => `
            <div class="hit">
              <img src="${esc(it.poster)}" alt="" loading="lazy" />
              <div class="grow"><b>${esc(it.name)}</b><div class="sub">${itemMeta(it).map(esc).join(' · ')}${it.rating ? ` · IMDb ${it.rating.toFixed(1)}` : ''}</div></div>
              ${have.has(it.id) ? '<span class="sub">✓ drauf</span>' : `<button class="btn small primary" data-add="${esc(it.id)}">+</button>`}
            </div>`).join('') + `<button class="hit linkish" data-manual="1">✍️ „${esc(term)}" selbst eintragen</button>`
        : `<p class="hint" style="padding:8px 12px">Nichts gefunden. <button class="linkish" data-manual="1">✍️ „${esc(term)}" selbst eintragen</button></p>`;
    } catch (err) {
      toast(err.message);
    }
  }, 250);
  q('search').addEventListener('input', search);

  function openManual(prefill = {}) {
    const term = prefill.name ?? q('search').value.trim();
    let type = 'movie';
    const ov = sheet(`
      <h2 style="margin:4px 0 6px">✍️ Selbst eintragen</h2>
      <p class="sub" style="margin:0 0 14px">Beim Tippen schauen wir in der Datenbank nach — ein Treffer übernimmt Poster und Infos. Sonst einfach frei eintragen.</p>
      <form class="form" id="manualForm">
        <div class="field"><label for="mName">Titel</label><input class="input" id="mName" maxlength="120" required value="${esc(term)}" autocomplete="off" />
          <div class="search-results" id="mHits"></div></div>
        <div class="chips" id="mType">
          <button type="button" class="chip on" data-type="movie">🎬 Film</button>
          <button type="button" class="chip" data-type="series">📺 Serie</button>
        </div>
        <div class="row">
          <div class="field" style="max-width:120px"><label for="mYear">Jahr</label><input class="input" id="mYear" type="number" inputmode="numeric" placeholder="z. B. 2021" /></div>
          <div class="field"><label for="mImdb">IMDb-Link (optional)</label><input class="input" id="mImdb" placeholder="imdb.com/title/tt…" autocapitalize="none" /></div>
        </div>
        <div class="field"><label for="mNote">Notiz (optional)</label><input class="input" id="mNote" maxlength="300" placeholder="z. B. „läuft auf Arte", „Tipp von Mama"" value="${esc(prefill.note || '')}" /></div>
        <button class="btn primary block">Hinzufügen</button>
      </form>`);
    // Datenbank-Treffer zum eingetippten Titel
    const hits = ov.querySelector('#mHits');
    const lookup = debounce(async () => {
      const t = ov.querySelector('#mName').value.trim();
      if (t.length < 2) return (hits.innerHTML = '');
      try {
        const { results } = await api(`/search?q=${encodeURIComponent(t)}`);
        if (ov.querySelector('#mName').value.trim() !== t) return;
        const have = new Set(data.entries.map((e) => e.item.id));
        hits.innerHTML = results.slice(0, 6).map((it) => `
          <div class="hit">
            <img src="${esc(it.poster)}" alt="" loading="lazy" />
            <div class="grow"><b>${esc(it.name)}</b><div class="sub">${itemMeta(it).map(esc).join(' · ')}${it.rating ? ` · IMDb ${it.rating.toFixed(1)}` : ''}</div></div>
            ${have.has(it.id) ? '<span class="sub">✓ drauf</span>' : `<button type="button" class="btn small primary" data-pick="${esc(it.id)}">Übernehmen</button>`}
          </div>`).join('') + (results.length ? '<p class="hint" style="padding:6px 12px;margin:0">Nicht dabei? Dann unten frei eintragen.</p>' : '');
      } catch {
        hits.innerHTML = '';
      }
    }, 250);
    ov.querySelector('#mName').addEventListener('input', lookup);
    lookup();
    hits.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      b.disabled = true;
      try {
        const { entryId } = await api(`/lists/${listId}/items`, { itemId: b.dataset.pick, priority: 2 });
        // Eine eingetippte Notiz wird zum ersten Kommentar
        const note = ov.querySelector('#mNote').value.trim();
        if (note && partner()) await api(`/entries/${entryId}`, { action: 'comment', text: note });
        ov.remove();
        q('search').value = '';
        q('results').innerHTML = '';
        toast(partner() ? `📌 Hinzugefügt — ${partner().name} bekommt Bescheid` : '📌 Hinzugefügt');
        await reload();
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
    });
    ov.querySelector('#mType').addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      type = b.dataset.type;
      for (const c of ov.querySelectorAll('#mType .chip')) c.classList.toggle('on', c === b);
    });
    ov.querySelector('#manualForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = ov.querySelector('#manualForm .btn.primary');
      btn.disabled = true;
      try {
        await api(`/lists/${listId}/manual`, {
          name: ov.querySelector('#mName').value,
          type,
          year: ov.querySelector('#mYear').value,
          imdb: ov.querySelector('#mImdb').value,
          note: ov.querySelector('#mNote').value,
          priority: 2,
        });
        ov.remove();
        q('search').value = '';
        q('results').innerHTML = '';
        toast(partner() ? `📌 Eingetragen — ${partner().name} bekommt Bescheid` : '📌 Eingetragen');
        await reload();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
    ov.querySelector('#mName').focus();
  }
  q('manualBtn').onclick = () => openManual();
  // Von der Teilen-Seite: Dialog gleich mit Titel und Link öffnen
  if (params.has('neu')) {
    openManual({ name: params.get('neu'), note: params.get('notiz') || '' });
    history.replaceState(null, '', location.pathname);
  }

  // --- Aktionen ----------------------------------------------------------------

  async function entryAction(entryId, body) {
    try {
      await api(`/entries/${entryId}`, body);
      await reload();
    } catch (err) {
      toast(err.message);
    }
  }

  async function onClick(e) {
    const t = e.target.closest('[data-trailer]');
    if (t) return openTrailer(data.entries.find((x) => x.item.id === t.dataset.trailer).item);
    const el = e.target.closest('[data-tab], [data-prio], [data-stars], [data-act], [data-open], [data-add], [data-manual], [data-react], [data-picker], [data-del]');
    if (!el) return;
    const d = el.dataset;
    if (d.manual) return openManual();
    if (d.add) {
      el.disabled = true;
      try {
        await api(`/lists/${listId}/items`, { itemId: d.add, priority: 2 });
        el.outerHTML = '<span class="sub">✓ drauf</span>';
        toast(partner() ? `📌 Hinzugefügt — ${partner().name} bekommt Bescheid` : '📌 Hinzugefügt');
        await reload();
      } catch (err) {
        toast(err.message);
        el.disabled = false;
      }
      return;
    }
    if (d.open) return openDetail(d.open);
    if (d.tab) {
      if (d.tab === 'unrated') {
        onlyUnrated = !onlyUnrated;
        return render();
      }
      return openTab(d.tab);
    }
    if (d.picker) {
      pickerFor = pickerFor === Number(d.picker) ? null : Number(d.picker);
      render();
      if (detail) renderDetail();
      return;
    }
    if (d.react) {
      pickerFor = null;
      try {
        await api(`/activities/${d.activity}`, { action: 'react', emoji: d.react });
      } catch (err) {
        toast(err.message);
      }
      return reload();
    }
    if (d.del) {
      if (!confirm('Kommentar löschen?')) return;
      try {
        await api(`/activities/${d.del}`, { action: 'delete' });
      } catch (err) {
        toast(err.message);
      }
      return reload();
    }
    if (d.prio) {
      const entry = entryOf(d.entry);
      const next = entry.ratings[me]?.priority === Number(d.prio) ? null : Number(d.prio); // nochmal tippen = zurücksetzen
      entry.ratings[me] = { ...entry.ratings[me], priority: next };
      render();
      if (detail) renderDetail();
      return entryAction(d.entry, { action: 'rate', priority: next });
    }
    if (d.stars) {
      const entry = entryOf(d.entry);
      const next = entry.ratings[me]?.stars === Number(d.stars) ? null : Number(d.stars);
      entry.ratings[me] = { ...entry.ratings[me], stars: next };
      render();
      if (detail) renderDetail();
      return entryAction(d.entry, { action: 'rate', stars: next });
    }
    if (d.act === 'watched') {
      toast('✓ Als gesehen markiert — wie war\'s? Sterne gibt\'s unter „Gesehen"');
      return entryAction(d.entry, { action: 'watched' });
    }
    if (d.act === 'unwatched') return entryAction(d.entry, { action: 'unwatched' });
    if (d.act === 'veto') {
      if (!confirm(`Veto gegen „${entryOf(d.entry).item.name}"? Der Titel fliegt aus Zufallstipp und gemeinsamen Sessions, bis du das Veto zurücknimmst.`)) return;
      return entryAction(d.entry, { action: 'veto' });
    }
    if (d.act === 'unveto') return entryAction(d.entry, { action: 'unveto' });
    if (d.act === 'remove') {
      if (!confirm(`„${entryOf(d.entry).item.name}" von der Liste nehmen?`)) return;
      detail?.ov.remove();
      return entryAction(d.entry, { action: 'remove' });
    }
    if (d.act === 'session') return startSession(el);
    if (d.act === 'pick') return pickTonight();
  }
  $app.querySelector('.page').addEventListener('click', onClick);

  async function onSubmit(e) {
    if (e.target.id !== 'commentForm') return;
    e.preventDefault();
    const input = detail.ov.querySelector('#commentText');
    const text = input.value.trim();
    if (!text) return input.focus();
    input.value = '';
    try {
      await api(`/entries/${detail.entryId}`, { action: 'comment', text });
      await reload();
      detail?.ov.querySelector('#commentText')?.focus();
    } catch (err) {
      input.value = text;
      toast(err.message);
    }
  }

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
  // Vetos fliegen raus; "eher nicht" nur, wenn sonst nichts übrig ist.
  function pickTonight(exclude = new Set()) {
    const open = data.entries.filter((e) => !e.watchedAt && !e.vetoedBy && !exclude.has(e.id));
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

  render();
  if (tab === 'activity') openTab('activity');
}
