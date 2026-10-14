// couchmatch — Teilen-Ziel: Videos aus TikTok, Instagram & Co. landen hier und werden zum Watchlist-Eintrag.

import { $app, ME, api, debounce, esc, go, itemMeta, needLogin, onLeave, toast, topline } from './common.js';

const LAST_LIST = 'couchmatch:shareList';
const SOURCE_ICON = { TikTok: '🎵', Instagram: '📸', YouTube: '▶️', Link: '🔗' };

export async function sharePage() {
  if (needLogin()) return;
  const params = new URLSearchParams(location.search);
  const input = { url: params.get('url') || '', text: params.get('text') || '', title: params.get('title') || '' };
  const lists = ME.lists || [];
  let listId = lists.find((l) => l.id === Number(localStorage.getItem(LAST_LIST)))?.id ?? lists[0]?.id;
  let shared = null; // Antwort von /api/share
  let alive = true;
  onLeave(() => (alive = false));

  // Ohne geteilten Inhalt (z. B. iPhone, das PWAs nicht als Teilen-Ziel kennt): Link einfügen
  if (!input.url && !input.text && !input.title) {
    $app.innerHTML = `
      <div class="page narrow">
        ${topline(`<a class="pill" href="/konto" data-link>← Konto</a>`)}
        <h1>📲 Aus TikTok & Co.</h1>
        <p class="lead">Link aus TikTok, Instagram oder YouTube einfügen — wir suchen den Film oder die Serie dazu.</p>
        <form class="form" id="pasteForm">
          <input class="input" id="pasteLink" placeholder="https://vm.tiktok.com/…" autocapitalize="none" autocomplete="off" />
          <button class="btn primary block">Los</button>
        </form>
        <p class="hint">Auf Android geht's noch schneller: couchmatch installieren, dann im Video auf „Teilen" → couchmatch.</p>
      </div>`;
    const field = document.getElementById('pasteLink');
    navigator.clipboard?.readText?.().then((t) => {
      if (alive && !field.value && /^https?:\/\//.test(t.trim())) field.value = t.trim();
    }).catch(() => {});
    document.getElementById('pasteForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = field.value.trim();
      if (v) go(`/teilen?text=${encodeURIComponent(v)}`);
    });
    field.focus();
    return;
  }

  $app.innerHTML = `
    <div class="page narrow">
      ${topline(`<a class="pill" href="/konto" data-link>← Konto</a>`)}
      <h1>📲 Geteilt</h1>
      <div class="shared-box" id="src"><div class="spinner"></div> Schaue nach, worum es geht …</div>
      ${lists.length > 1 ? `<h3 class="sec-title">Auf welche Liste?</h3><div class="chips" id="lists" style="margin-bottom:18px"></div>` : ''}
      <div id="found"></div>
      <h3 class="sec-title" style="margin-top:18px">Selbst suchen</h3>
      <div class="search">
        <input class="input" id="search" type="search" placeholder="🔎 Film oder Serie …" autocomplete="off" />
        <div class="search-results" id="results"></div>
        <button class="linkish" id="manualBtn">✍️ Nicht dabei? Selbst eintragen</button>
      </div>
    </div>`;
  const q = (id) => document.getElementById(id);

  if (!lists.length) {
    q('found').innerHTML = `<p class="hint">Du hast noch keine Watchlist. <a href="/konto" data-link>Zum Konto</a></p>`;
  }

  function renderLists() {
    if (!q('lists')) return;
    q('lists').innerHTML = lists.map((l) => `
      <button type="button" class="chip${l.id === listId ? ' on' : ''}" data-list="${l.id}">${l.partner ? '💞' : '📌'} ${esc(l.title)}</button>`).join('');
  }
  renderLists();
  q('lists')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-list]');
    if (!b) return;
    listId = Number(b.dataset.list);
    localStorage.setItem(LAST_LIST, listId);
    renderLists();
  });

  const hitHtml = (it) => `
    <div class="hit">
      <img src="${esc(it.poster)}" alt="" loading="lazy" />
      <div class="grow"><b>${esc(it.name)}</b><div class="sub">${itemMeta(it).map(esc).join(' · ')}${it.rating ? ` · IMDb ${it.rating.toFixed(1)}` : ''}</div></div>
      <button type="button" class="btn small primary" data-add="${esc(it.id)}">+</button>
    </div>`;

  // Der Link wird zum ersten Kommentar, damit beide das Video wiederfinden
  const linkNote = () => {
    if (!shared?.link) return '';
    return shared.source === 'Link' ? `🔗 ${shared.link}` : `${SOURCE_ICON[shared.source]} Gesehen auf ${shared.source}: ${shared.link}`;
  };

  async function addItem(btn) {
    if (!listId) return toast('Erst eine Watchlist anlegen.');
    btn.disabled = true;
    try {
      const { entryId } = await api(`/lists/${listId}/items`, { itemId: btn.dataset.add, priority: 2 });
      const list = lists.find((l) => l.id === listId);
      if (linkNote() && list?.partner) await api(`/entries/${entryId}`, { action: 'comment', text: linkNote() });
      localStorage.setItem(LAST_LIST, listId);
      toast(list?.partner ? '📌 Hinzugefügt — Bescheid ist unterwegs' : '📌 Hinzugefügt');
      go(`/w/${listId}`);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  }
  $app.querySelector('.page').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (b) addItem(b);
  });

  const search = debounce(async () => {
    const term = q('search').value.trim();
    if (term.length < 2) return (q('results').innerHTML = '');
    try {
      const { results } = await api(`/search?q=${encodeURIComponent(term)}`);
      if (!alive || q('search').value.trim() !== term) return;
      q('results').innerHTML = results.length
        ? results.slice(0, 8).map(hitHtml).join('')
        : '<p class="hint" style="padding:8px 12px">Nichts gefunden — dann einfach selbst eintragen.</p>';
    } catch (err) {
      toast(err.message);
    }
  }, 250);
  q('search').addEventListener('input', search);

  // Selbst eintragen läuft über den Dialog der Watchlist, vorausgefüllt mit Titel und Link
  q('manualBtn').onclick = () => {
    if (!listId) return toast('Erst eine Watchlist anlegen.');
    const p = new URLSearchParams({ neu: q('search').value.trim() || shared?.query || '' });
    if (shared?.link) p.set('notiz', shared.link);
    go(`/w/${listId}?${p}`);
  };

  try {
    shared = await api('/share', input);
  } catch (err) {
    if (!alive) return;
    q('src').innerHTML = `<p class="sub" style="margin:0">${esc(err.message)}</p>`;
    return;
  }
  if (!alive) return;
  const caption = shared.caption || shared.shared;
  q('src').innerHTML = `
    <div class="sub">${SOURCE_ICON[shared.source] || '🔗'} ${esc(shared.source || 'Geteilt')}${shared.author ? ` · ${esc(shared.author)}` : ''}</div>
    ${caption ? `<p class="caption">${esc(caption.length > 220 ? caption.slice(0, 219) + '…' : caption)}</p>` : '<p class="sub" style="margin:6px 0 0">Kein Text zum Video gefunden.</p>'}
    ${shared.link ? `<a class="sub" href="${esc(shared.link)}" target="_blank" rel="noopener">Video öffnen ↗</a>` : ''}`;
  q('found').innerHTML = shared.hits.length
    ? `<h3 class="sec-title">${shared.hits.length > 1 ? 'Meinst du einen davon?' : 'Erkannt'}</h3>
       <div class="search-results">${shared.hits.map(hitHtml).join('')}</div>`
    : lists.length ? '<p class="hint">Keinen Titel erkannt — such ihn unten oder trag ihn selbst ein.</p>' : q('found').innerHTML;
  if (!q('search').value) {
    q('search').value = shared.hits.length ? '' : shared.query;
    if (q('search').value) search();
  }
}
