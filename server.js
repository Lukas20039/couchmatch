// couchmatch — HTTP-Server ohne Abhängigkeiten.
// API unter /api, Live-Updates per Server-Sent Events, Frontend aus ./public.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES, GENRES, MOODS, allItems, catalogStatus, filterItems, findItem, loadCatalog, sample,
  sanitizeFilters, searchItems, syncCatalog, toCard,
} from './lib/catalog.js';
import {
  HttpError, addItems, authPlayer, castVote, createRoom, flushRooms, getRoom, joinRoom, loadRooms,
  matches, pickFinal, resetFinal, roomsOf, startFinal, toggleVeto, viewFor,
} from './lib/rooms.js';
import * as accounts from './lib/accounts.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8095;
const HOST = process.env.HOST || '0.0.0.0';
const SIGNUP = process.env.SIGNUP !== 'closed';
const COOKIE = 'cm_sid';

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

if (process.argv.includes('--sync-only')) {
  await syncCatalog(DATA_DIR, log);
  process.exit(0);
}

await loadRooms(DATA_DIR);
await loadCatalog(DATA_DIR, log);
accounts.openDb(DATA_DIR);

// --- Live-Updates ---------------------------------------------------------

const streams = new Map(); // roomId -> Set<{res, playerId}>
const accountStreams = new Map(); // accountId -> Set<res>

function broadcast(room) {
  for (const s of streams.get(room.id) || []) {
    s.res.write(`data: ${JSON.stringify(viewFor(room, s.playerId))}\n\n`);
  }
}

// Konto-Seiten laden bei einem Hinweis einfach neu — der Inhalt kommt per normalem GET
function pokeAccounts(ids) {
  for (const id of ids) for (const res of accountStreams.get(id) || []) res.write('data: {"type":"changed"}\n\n');
}
accounts.onAccountChange(pokeAccounts);

function openStream(req, res, map, key, first) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(first.entry);
  res.write(`data: ${first.data}\n\n`);
  req.on('close', () => {
    const set = map.get(key);
    set?.delete(first.entry);
    if (set && !set.size) map.delete(key);
  });
}

setInterval(() => {
  for (const set of streams.values()) for (const s of set) s.res.write(': ping\n\n');
  for (const set of accountStreams.values()) for (const res of set) res.write(': ping\n\n');
}, 25000).unref();

// --- Helfer ---------------------------------------------------------------

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Anfrage zu groß.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Ungültiges JSON.');
  }
}

function requireCatalog() {
  if (!catalogStatus().ready) throw new HttpError(503, 'Die Datenbank wird gerade aufgebaut — einen Moment bitte.');
}

const clampCount = (n) => Math.min(200, Math.max(1, Math.round(Number(n) || 50)));

function roomOr404(id) {
  const room = getRoom(id);
  if (!room) throw new HttpError(404, 'Diese Session gibt es nicht (mehr).');
  return room;
}

// --- Anmeldung per Cookie ---------------------------------------------------

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sessionToken = (req) => cookies(req)[COOKIE] || null;
const currentAccount = (req) => accounts.sessionAccount(sessionToken(req));

function requireAccount(req) {
  const me = currentAccount(req);
  if (!me) throw new HttpError(401, 'Bitte zuerst anmelden.');
  return me;
}

function setSessionCookie(req, res, token) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const life = token ? `; Max-Age=${180 * 24 * 3600}` : '; Max-Age=0';
  res.setHeader('set-cookie', `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax${life}${secure}`);
}

// Kurzinfo einer Session für Listen im Konto
function roomSummary(room, accountId) {
  const me = room.players.find((p) => p.accountId === accountId);
  return {
    id: room.id,
    players: room.players.map((p) => p.name),
    count: room.items.length,
    matches: matches(room).length,
    winner: room.final?.winner ? room.items.find((i) => i.id === room.final.winner)?.name : null,
    updatedAt: room.updatedAt,
    filters: room.filters,
    ...(me && { mine: Object.keys(room.votes[me.id] || {}).length, playerId: me.id, token: me.token }),
  };
}

function accountState(me) {
  const invites = [];
  for (const inv of accounts.invitesFor(me)) {
    const room = getRoom(inv.roomId);
    if (!room || room.players.some((p) => p.accountId === me.id)) accounts.dropInvite(inv.roomId, me.id);
    else invites.push({ ...inv, room: roomSummary(room, me.id) });
  }
  return {
    account: me,
    ...accounts.social(me),
    lists: accounts.myLists(me),
    invites,
    rooms: roomsOf(me.id).slice(0, 12).map(({ room }) => roomSummary(room, me.id)),
  };
}

// Mitspieler mit Konto, die mit mir befreundet sind
const roomFriends = (room, me) =>
  room.players.filter((p) => p.accountId && p.accountId !== me.id && accounts.areFriends(me.id, p.accountId));

function cardFor(itemId, room) {
  const it = findItem(itemId);
  return it ? toCard(it) : room?.items.find((i) => i.id === itemId) || null;
}

// Titelpool fürs Setup — optional ohne alles, was man schon gesehen hat
function poolFor(req, body) {
  const filters = sanitizeFilters(body.filters);
  let list = filterItems(allItems(), filters);
  const me = body.excludeWatched ? currentAccount(req) : null;
  if (me) {
    const invited = [].concat(body.invite || []).map(Number).filter((id) => accounts.areFriends(me.id, id));
    const seen = accounts.watchedIds([me.id, ...invited]);
    list = list.filter((i) => !seen.has(i.id));
  }
  return { filters, list, me };
}

// --- API ------------------------------------------------------------------

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // ohne "api"
  const method = req.method;

  // Zusammen mit SameSite=Lax verhindert das Formular-Angriffe von fremden Seiten (CSRF)
  if (method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Bitte JSON senden.');
  }

  if (method === 'GET' && parts[0] === 'meta') {
    return send(res, 200, {
      catalog: catalogStatus(),
      genres: GENRES,
      categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])),
      moods: MOODS,
      priorities: accounts.PRIORITIES,
      signup: SIGNUP,
    });
  }

  if (method === 'GET' && parts[0] === 'search') {
    requireCatalog();
    return send(res, 200, { results: searchItems(url.searchParams.get('q') || '', 20) });
  }

  if (parts[0] === 'auth') return authApi(req, res, parts[1], method);
  if (parts[0] === 'me') return meApi(req, res, parts.slice(1), method);
  if (parts[0] === 'friends') return friendsApi(req, res, parts.slice(1), method);
  if (parts[0] === 'lists' || parts[0] === 'entries') return listsApi(req, res, parts, method, url);

  if (method === 'POST' && parts[0] === 'preview') {
    requireCatalog();
    const { list } = poolFor(req, await readBody(req));
    return send(res, 200, {
      available: list.length,
      movies: list.filter((i) => i.type === 'movie').length,
      series: list.filter((i) => i.type === 'series').length,
      sample: sample(list, 12).map((i) => ({ id: i.id, name: i.name, poster: i.poster })),
    });
  }

  if (method === 'POST' && parts[0] === 'rooms' && parts.length === 1) {
    const body = await readBody(req);
    const me = currentAccount(req);
    let filters;
    let items;
    if (body.listId != null) {
      // Watchlist-Session: genau die offenen Einträge einer Liste
      if (!me) throw new HttpError(401, 'Bitte zuerst anmelden.');
      const info = accounts.myLists(me).find((l) => l.id === Number(body.listId));
      items = accounts.openEntries(me, body.listId);
      if (items.length < 2) throw new HttpError(400, 'Für eine Session braucht die Watchlist mindestens 2 offene Titel.');
      const owners = info?.partner ? `${me.name} & ${info.partner.name}` : me.name;
      filters = { source: 'watchlist', listTitle: `Watchlist von ${owners}`, types: [] };
      items = sample(items, items.length);
    } else {
      requireCatalog();
      const pool = poolFor(req, body);
      if (!pool.list.length) throw new HttpError(400, 'Mit diesen Filtern gibt es keine Titel.');
      filters = pool.filters;
      items = sample(pool.list, clampCount(body.count)).map(toCard);
    }
    const superLimit = Math.min(50, Math.max(0, Math.round(Number(body.superLimit) || 0)));
    const vetoLimit = Math.min(5, Math.max(0, Math.round(Number(body.vetoLimit) || 0)));
    const { room, player } = createRoom({
      filters,
      superLimit,
      vetoLimit,
      items,
      hostName: me?.name || body.name,
      hostAccountId: me?.id ?? null,
    });
    if (me) for (const fid of [].concat(body.invite || [])) accounts.inviteToRoom(me, room.id, Number(fid));
    log.info(`Session ${room.id} erstellt (${room.items.length} Titel${body.listId != null ? ', aus Watchlist' : ''})`);
    return send(res, 201, { roomId: room.id, playerId: player.id, token: player.token });
  }

  if (parts[0] !== 'rooms' || !parts[1]) throw new HttpError(404, 'Nicht gefunden.');
  const room = roomOr404(parts[1]);
  const action = parts[2] || '';

  if (method === 'GET' && action === 'events') {
    const playerId = url.searchParams.get('playerId');
    authPlayer(room, playerId, url.searchParams.get('token'));
    const entry = { res, playerId };
    return openStream(req, res, streams, room.id, { entry, data: JSON.stringify(viewFor(room, playerId)) });
  }

  if (method === 'GET' && action === '') {
    // Öffentliche Kurzinfo für die Einladungsseite
    const me = currentAccount(req);
    const mine = me && room.players.find((p) => p.accountId === me.id);
    return send(res, 200, {
      id: room.id,
      host: room.players[0].name,
      players: room.players.map((p) => p.name),
      count: room.items.length,
      filters: room.filters,
      // Angemeldet und schon dabei (z. B. auf einem anderen Gerät) → Zugang direkt mitgeben
      ...(mine && { playerId: mine.id, token: mine.token }),
    });
  }

  if (method === 'POST' && action === 'join') {
    const body = await readBody(req);
    const me = currentAccount(req);
    const p = joinRoom(room, me?.name || body.name, me?.id ?? null);
    if (me) accounts.dropInvite(room.id, me.id);
    log.info(`Session ${room.id}: ${p.name} beigetreten`);
    broadcast(room);
    pokeAccounts(room.players.map((x) => x.accountId).filter(Boolean));
    return send(res, 201, { playerId: p.id, token: p.token });
  }

  if (method === 'GET' && action === 'context') {
    // Konto-Bezug der Session: in welche Watchlist Matches gehören, wen man einladen kann
    const me = currentAccount(req);
    if (!me || !room.players.some((p) => p.accountId === me.id)) return send(res, 200, { account: false });
    const lists = accounts.myLists(me);
    const partnerIds = new Set(roomFriends(room, me).map((p) => p.accountId));
    const def = lists.find((l) => l.partner && partnerIds.has(l.partner.id)) || lists[0];
    const roomIds = new Set(room.items.map((i) => i.id));
    const { friends } = accounts.social(me);
    const inRoom = new Set(room.players.map((p) => p.accountId).filter(Boolean));
    return send(res, 200, {
      account: true,
      defaultListId: def.id,
      lists: lists.map((l) => ({
        id: l.id,
        title: l.title,
        onList: accounts.listItemIds(me, l.id).filter((id) => roomIds.has(id)),
      })),
      friends: friends.map((f) => ({ ...f, joined: inRoom.has(f.id) })),
    });
  }

  if (method === 'POST' && action === 'invite') {
    const me = requireAccount(req);
    if (!room.players.some((p) => p.accountId === me.id)) throw new HttpError(403, 'Du spielst in dieser Session nicht mit.');
    const body = await readBody(req);
    accounts.inviteToRoom(me, room.id, Number(body.friendId));
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && action === 'vote') {
    const body = await readBody(req);
    const p = authPlayer(room, body.playerId, body.token);
    castVote(room, p, String(body.itemId || ''), body.vote ?? null);
    broadcast(room);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && action === 'veto') {
    const body = await readBody(req);
    const p = authPlayer(room, body.playerId, body.token);
    toggleVeto(room, p, String(body.itemId || ''));
    broadcast(room);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && action === 'final') {
    const body = await readBody(req);
    const p = authPlayer(room, body.playerId, body.token);
    if (body.action === 'start') startFinal(room);
    else if (body.action === 'reset') resetFinal(room);
    else if (body.action === 'pick') pickFinal(room, p, Number(body.duel), String(body.itemId || ''));
    else throw new HttpError(400, 'Unbekannte Aktion.');
    broadcast(room);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && action === 'more') {
    requireCatalog();
    const body = await readBody(req);
    authPlayer(room, body.playerId, body.token);
    if (room.filters.source === 'watchlist') throw new HttpError(409, 'Diese Session besteht nur aus eurer Watchlist.');
    const have = new Set(room.items.map((i) => i.id));
    const list = filterItems(allItems(), room.filters).filter((i) => !have.has(i.id));
    if (!list.length) throw new HttpError(409, 'Keine weiteren Titel für diese Filter.');
    const added = sample(list, Math.min(50, clampCount(body.count))).map(toCard);
    addItems(room, added);
    broadcast(room);
    return send(res, 200, { added: added.length });
  }

  throw new HttpError(404, 'Nicht gefunden.');
}

async function authApi(req, res, action, method) {
  if (method !== 'POST') throw new HttpError(404, 'Nicht gefunden.');
  const body = await readBody(req);
  if (action === 'register') {
    if (!SIGNUP) throw new HttpError(403, 'Neue Konten sind auf diesem Server deaktiviert.');
    const account = await accounts.register(body);
    setSessionCookie(req, res, accounts.createSession(account.id));
    log.info(`Konto ${account.username} angelegt`);
    return send(res, 201, { account });
  }
  if (action === 'login') {
    const { account, token } = await accounts.login(body);
    setSessionCookie(req, res, token);
    return send(res, 200, { account });
  }
  if (action === 'logout') {
    accounts.logout(sessionToken(req));
    setSessionCookie(req, res, null);
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Nicht gefunden.');
}

async function meApi(req, res, parts, method) {
  if (method === 'GET' && !parts.length) {
    const me = currentAccount(req);
    return send(res, 200, me ? accountState(me) : { account: null });
  }
  const me = requireAccount(req);
  if (method === 'GET' && parts[0] === 'events') {
    return openStream(req, res, accountStreams, me.id, { entry: res, data: '{"type":"hello"}' });
  }
  if (method !== 'POST') throw new HttpError(404, 'Nicht gefunden.');
  const body = await readBody(req);
  if (parts[0] === 'profile') return send(res, 200, { account: accounts.updateProfile(me, body) });
  if (parts[0] === 'password') {
    setSessionCookie(req, res, await accounts.changePassword(me, body));
    return send(res, 200, { ok: true });
  }
  if (parts[0] === 'delete') {
    await accounts.deleteAccount(me, body);
    setSessionCookie(req, res, null);
    log.info(`Konto ${me.username} gelöscht`);
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Nicht gefunden.');
}

async function friendsApi(req, res, parts, method) {
  const me = requireAccount(req);
  if (method !== 'POST') throw new HttpError(404, 'Nicht gefunden.');
  const body = await readBody(req);
  if (!parts.length) return send(res, 200, accounts.requestFriend(me, body.username));
  const otherId = Number(parts[0]);
  if (body.action === 'accept' || body.action === 'decline') {
    return send(res, 200, accounts.respondFriend(me, otherId, body.action === 'accept'));
  }
  if (body.action === 'remove') {
    accounts.removeFriend(me, otherId);
    return send(res, 200, { ok: true });
  }
  throw new HttpError(400, 'Unbekannte Aktion.');
}

async function listsApi(req, res, parts, method) {
  const me = requireAccount(req);
  const [kind, id, sub] = parts;
  if (kind === 'lists' && method === 'GET' && id && !sub) return send(res, 200, accounts.listView(me, id));
  if (kind === 'lists' && method === 'POST' && sub === 'items') {
    const body = await readBody(req);
    const card = cardFor(String(body.itemId || ''), body.roomId ? getRoom(String(body.roomId)) : null);
    if (!card) throw new HttpError(404, 'Diesen Titel kenne ich nicht.');
    const entryId = accounts.addEntry(me, id, card, body.priority ?? null);
    return send(res, 201, { entryId });
  }
  if (kind === 'entries' && method === 'POST' && id) {
    const body = await readBody(req);
    if (body.action === 'rate') accounts.rateEntry(me, id, body);
    else if (body.action === 'watched') accounts.setWatched(me, id, true);
    else if (body.action === 'unwatched') accounts.setWatched(me, id, false);
    else if (body.action === 'remove') accounts.removeEntry(me, id);
    else throw new HttpError(400, 'Unbekannte Aktion.');
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Nicht gefunden.');
}

// --- Statische Dateien ----------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || /^\/(r|w)\/|^\/(konto|login)$/.test(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'Nicht gefunden.' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Nicht gefunden.' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(res, url.pathname);
    else send(res, 405, { error: 'Methode nicht erlaubt.' });
  } catch (err) {
    if (!(err instanceof HttpError)) log.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Interner Fehler.' });
  }
});

server.listen(PORT, HOST, () => log.info(`couchmatch läuft auf http://${HOST}:${PORT}`));

// Im Container läuft Node als PID 1 und muss SIGTERM selbst behandeln
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log.info(`${sig} empfangen, fahre herunter …`);
    for (const set of streams.values()) for (const s of set) s.res.end();
    for (const set of accountStreams.values()) for (const r of set) r.end();
    server.close();
    await flushRooms().catch((err) => log.error(err));
    accounts.closeDb();
    process.exit(0);
  });
}
